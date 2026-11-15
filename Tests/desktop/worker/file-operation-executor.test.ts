import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteFileMetadataError, RemoteFileMissingError, type SshTransport } from '@cloudhelm/adapters';
import { TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, operationOutcome, type ProposedOperation } from '@cloudhelm/core';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const id = terminal.open('host', { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, 'task');
  const scope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: id, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy' };
  const writeFile = vi.fn(); const deleteFile = vi.fn();
  const ssh = { writeFile, deleteFile, connectionGeneration: () => 1,
    // Default: the target does not exist yet, so a plain create/write proceeds.
    readFileForEdit: vi.fn(async () => { throw new RemoteFileMissingError(); }) } as unknown as SshTransport;
  const commands = { execute: vi.fn() };
  return { terminal, id, scope, writeFile, deleteFile, ssh, commands, executor: new FileOperationExecutor(terminal, ssh, commands) };
}

describe('structured operation authorization continuity', () => {
  it('does not dispatch an upload when policy changes during local file loading', async () => {
    const f = fixture(); let authorized = true; const data = Buffer.from('file');
    vi.spyOn(LocalFileAccess.prototype, 'read').mockImplementation(async () => {
      authorized = false; return { data, scope: { path: '/source', kind: 'directory' } };
    });
    const operation: ProposedOperation = { id: 'upload', kind: 'upload', localRoot: '/source', localPath: '/source/file', remotePath: '/srv/app/file',
      size: data.length, contentSha256: createHash('sha256').update(data).digest('hex'), scope: f.scope };
    expect((await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => authorized })).status).toBe('failed');
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('reports a post-review local change as not dispatched, with no remote effects to verify', async () => {
    const f = fixture(); const data = Buffer.from('file');
    vi.spyOn(LocalFileAccess.prototype, 'read').mockResolvedValue({ data: Buffer.from('changed'), scope: { path: '/source', kind: 'directory' } });
    const operation: ProposedOperation = { id: 'upload', kind: 'upload', localRoot: '/source', localPath: '/source/file', remotePath: '/srv/app/file',
      size: data.length, contentSha256: createHash('sha256').update(data).digest('hex'), scope: f.scope };
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(operationOutcome(result)).toMatchObject({ execution: 'not-started', effects: 'none', nextAction: 'revise-operation' });
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('treats an expired lease before dispatch as a correctable refusal, not an unknown remote outcome', async () => {
    const f = fixture();
    const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', scope: f.scope };
    const result = await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => false });
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('passes a live lease and policy guard through to SFTP mutation boundaries', async () => {
    const f = fixture(); let authorized = true;
    f.writeFile.mockImplementation(async (_host: string, _path: string, _content: Buffer, assertAuthorized: () => void) => {
      assertAuthorized(); authorized = false; assertAuthorized();
    });
    const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', scope: f.scope };
    expect((await f.executor.execute(operation, operationFingerprint(operation), undefined, { isAuthorized: () => authorized })).status).toBe('unknown');
    expect(f.writeFile).toHaveBeenCalledOnce();
  });

  it('propagates cancellation to the private SFTP action rather than only checking between callbacks', async () => {
    const f = fixture(), controller = new AbortController();
    const write: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', scope: f.scope };
    await f.executor.execute(write, operationFingerprint(write), controller.signal);
    expect(f.writeFile.mock.calls[0]?.[4]).toBe(controller.signal);
    expect(f.writeFile.mock.calls[0]?.[5]).toMatchObject({ createOnly: true });
    const remove: ProposedOperation = { id: 'delete', kind: 'delete-path', path: '/srv/app/file', scope: f.scope };
    await f.executor.execute(remove, operationFingerprint(remove), controller.signal);
    expect(f.deleteFile.mock.calls[0]?.[3]).toBe(controller.signal);
  });

  it('passes the same authorization capability to command execution', async () => {
    const f = fixture(); const options = { readOnly: true, isAuthorized: () => true };
    f.commands.execute.mockResolvedValue({ operationId: 'read', status: 'succeeded', stdoutTail: '' });
    const operation: ProposedOperation = { id: 'read', kind: 'command', command: 'cat /srv/app/file', scope: f.scope };
    await f.executor.execute(operation, operationFingerprint(operation), undefined, options);
    expect(f.commands.execute).toHaveBeenCalledWith(operation, operationFingerprint(operation), undefined, options);
  });
});

describe('conditional write and read-back verification', () => {
  const writeOp = (fields: Partial<Extract<ProposedOperation, { kind: 'write-file' }>> = {}): ProposedOperation => ({
    id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'next\n', ...fields, scope: fixture().scope });

  it('refuses to replace an existing file without the hash the review was based on', async () => {
    const f = fixture();
    const operation = { ...writeOp(), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn(async () => ({ content: 'current\n', bytes: 8, truncated: false,
      sha256: 'a'.repeat(64), mode: 0o644, uid: 1, gid: 1 }));
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(result.stdoutTail).toContain('no expected hash');
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('aborts without writing when the remote file changed since it was read', async () => {
    const f = fixture();
    const operation = { ...writeOp({ expectedSha256: 'b'.repeat(64) }), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn(async () => ({ content: 'current\n', bytes: 8, truncated: false,
      sha256: 'c'.repeat(64), mode: 0o644, uid: 1, gid: 1 }));
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(result.stdoutTail).toContain('changed since it was read');
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('forwards a reviewed hash and verifies a transport-confirmed write by read-back', async () => {
    const f = fixture();
    const intended = Buffer.from('next\n');
    const hash = createHash('sha256').update(intended).digest('hex');
    const operation = { ...writeOp({ expectedSha256: hash }), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn()
      .mockResolvedValueOnce({ content: 'current\n', bytes: 8, truncated: false, sha256: hash, mode: 0o640, uid: 1, gid: 1 })
      .mockResolvedValueOnce({ content: 'next\n', bytes: intended.length, truncated: false, sha256: hash, mode: 0o640, uid: 1, gid: 1 });
    f.writeFile.mockResolvedValue({ backup: '/srv/app/file.cloudhelm-backup-x' });
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result.status).toBe('succeeded');
    expect(f.writeFile).toHaveBeenCalledOnce();
    expect(result.stdoutTail).toContain('Verified read-back hash');
    expect(f.writeFile.mock.calls[0]?.[5]).toEqual({ expectedSha256: hash, createOnly: false });
    // This transport double accepts replacement; production SFTP now refuses it.
    // A returned backup is only bytes, never proof of metadata or service rollback.
    expect(result.stdoutTail).toContain('file bytes only');
    expect(result.stdoutTail).toContain('ACL/xattr and service state are not restored');
  });

  it('reports an SFTP metadata refusal as not started, with no remote outcome to verify', async () => {
    const f = fixture(), hash = 'a'.repeat(64);
    const operation = { ...writeOp({ expectedSha256: hash }), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn(async () => ({ content: 'current', bytes: 7, truncated: false,
      sha256: hash, mode: 0o600, uid: 1, gid: 1 }));
    f.writeFile.mockRejectedValue(new RemoteFileMetadataError());
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(operationOutcome(result)).toMatchObject({ execution: 'not-started', effects: 'none', nextAction: 'revise-operation' });
    expect(result.stdoutTail).toContain('ACL/xattr'); expect(result.stdoutTail).toContain('not delete-and-recreate');
    expect(f.ssh.readFileForEdit).toHaveBeenCalledOnce();
  });

  it('describes a deletion backup as bytes only, not metadata-preserving recovery', async () => {
    const f = fixture(); f.deleteFile.mockResolvedValue('/srv/app/file.backup');
    const operation: ProposedOperation = { id: 'delete', kind: 'delete-path', path: '/srv/app/file', scope: f.scope };
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result.status).toBe('succeeded');
    expect(result.stdoutTail).toContain('Content-only recovery copy');
    expect(result.stdoutTail).toContain('owner/group/mode, ACL/xattr and service state are not restored');
  });

  it('reports an unverified write instead of claiming success when the read-back differs', async () => {
    const f = fixture();
    const hash = createHash('sha256').update('next\n').digest('hex');
    const operation = { ...writeOp({ expectedSha256: hash }), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn()
      .mockResolvedValueOnce({ content: 'current\n', bytes: 8, truncated: false, sha256: hash, mode: 0o644, uid: 1, gid: 1 })
      .mockRejectedValueOnce(new Error('Remote file does not exist'));
    f.writeFile.mockResolvedValue({ backup: undefined });
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result.stdoutTail).toContain('final content is unconfirmed');
    expect(result).toMatchObject({ status: 'unknown', effects: 'possible' });
    expect(result.exitCode).toBeUndefined();
  });

  it('does not recreate a disappeared file when a prior hash was required', async () => {
    const f = fixture();
    const operation = { ...writeOp({ expectedSha256: 'a'.repeat(64) }), scope: f.scope } as ProposedOperation;
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
    expect(f.writeFile).not.toHaveBeenCalled();
  });

  it('honours createOnly without overwriting an existing file', async () => {
    const f = fixture();
    const operation = { ...writeOp({ createOnly: true }), scope: f.scope } as ProposedOperation;
    f.ssh.readFileForEdit = vi.fn(async () => ({ content: 'current\n', bytes: 8, truncated: false,
      sha256: 'd'.repeat(64), mode: 0o644, uid: 1, gid: 1 }));
    const result = await f.executor.execute(operation, operationFingerprint(operation));
    expect(result.stdoutTail).toContain('already exists');
    expect(f.writeFile).not.toHaveBeenCalled();
  });
});
