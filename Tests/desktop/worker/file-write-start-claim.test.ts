import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RemoteFileMissingError, type SshTransport } from '@cloudhelm/adapters';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer } from '../../../packages/adapters/src/bash-analyzer.js';
import { operationFingerprint, structuredFileTargetOf,
  type ExecutionOptions, type FileStartTarget, type OperationResult, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
type RemoteFileState = Awaited<ReturnType<SshTransport['readFileForEdit']>>;

function executorFixture() {
  const terminal = new TerminalManager({ data() {}, state() {} });
  const id = terminal.open('host', { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, 'task');
  const scope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: id, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy' };
  const events: string[] = [];
  const writeFile = vi.fn(async () => { events.push('write'); return { backup: '/srv/app/file.cloudhelm-backup-x' }; });
  const deleteFile = vi.fn(async () => { events.push('delete'); return '/srv/app/file.backup'; });
  const readFileForEdit = vi.fn(async (): Promise<RemoteFileState> => { events.push('preflight'); throw new RemoteFileMissingError(); });
  const ssh = { writeFile, deleteFile, readFileForEdit, connectionGeneration: () => 1 } as unknown as SshTransport;
  const commands = { execute: vi.fn() };
  return { terminal, scope, events, writeFile, deleteFile, readFileForEdit, ssh,
    executor: new FileOperationExecutor(terminal, ssh, commands) };
}

/** One-shot claim mirroring the gate's semantics: first call decides, later calls fail. */
function oneShotClaim(reviewed: FileStartTarget) {
  let closed = false;
  const calls: FileStartTarget[] = [];
  const claim = (target: FileStartTarget): boolean => {
    calls.push({ ...target });
    if (closed) return false;
    closed = true;
    return target.hostId === reviewed.hostId && target.operationKind === reviewed.operationKind
      && target.path === reviewed.path && (target.contentSha256 ?? undefined) === (reviewed.contentSha256 ?? undefined);
  };
  return { claim, calls, closed: () => closed };
}

it('consumes the file claim once at the writeFile handoff, after the read-only preflight', async () => {
  const f = executorFixture();
  const content = 'next\n';
  const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file',
    expectedSha256: sha256('current\n'), content, scope: f.scope };
  const claim = oneShotClaim(structuredFileTargetOf(operation)!);
  const orderedClaim = (target: FileStartTarget): boolean => { f.events.push('claim'); return claim.claim(target); };
  let preflights = 0;
  f.readFileForEdit.mockImplementation(async () => {
    f.events.push('preflight');
    preflights += 1;
    return preflights === 1
      ? { content: 'current\n', bytes: 8, truncated: false, sha256: sha256('current\n'), mode: 0o644, uid: 1, gid: 1 }
      : { content, bytes: content.length, truncated: false, sha256: sha256(content), mode: 0o644, uid: 1, gid: 1 };
  });
  const result = await f.executor.execute(operation, operationFingerprint(operation), undefined,
    { claimFileStart: orderedClaim });
  expect(claim.calls).toEqual([{ hostId: 'host', path: '/srv/app/file', operationKind: 'write-file', contentSha256: sha256(content) }]);
  expect(f.events).toEqual(['preflight', 'claim', 'write', 'preflight']); // Preflight first, claim at the handoff, read-back last.
  expect(result).toMatchObject({ status: 'succeeded', handoff: 'handed-off', businessStart: 'started' });
  expect(f.writeFile).toHaveBeenCalledOnce();
});

it('dispatches no SFTP mutation when the file claim is denied at the handoff', async () => {
  const f = executorFixture();
  const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file', content: 'new', scope: f.scope };
  const claim = oneShotClaim({ ...structuredFileTargetOf(operation)!, path: '/srv/other/file' });
  const result = await f.executor.execute(operation, operationFingerprint(operation), undefined,
    { claimFileStart: claim.claim });
  expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
  expect(f.writeFile).not.toHaveBeenCalled();
  expect(claim.calls.length).toBe(1);
});

it('never consumes the file claim when the preflight refuses the write', async () => {
  const f = executorFixture();
  const operation: ProposedOperation = { id: 'write', kind: 'write-file', path: '/srv/app/file',
    expectedSha256: 'b'.repeat(64), content: 'next\n', scope: f.scope };
  const claim = oneShotClaim(structuredFileTargetOf(operation)!);
  f.readFileForEdit.mockResolvedValue({ content: 'current\n', bytes: 8, truncated: false,
    sha256: 'c'.repeat(64), mode: 0o644, uid: 1, gid: 1 });
  const result = await f.executor.execute(operation, operationFingerprint(operation), undefined,
    { claimFileStart: claim.claim });
  expect(result).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'not-dispatched' });
  expect(claim.calls.length).toBe(0); // The preflight refusal never reaches the write handoff.
  expect(f.writeFile).not.toHaveBeenCalled();
});

it('binds delete-path to the reviewed path without a content hash', async () => {
  const f = executorFixture();
  const operation: ProposedOperation = { id: 'delete', kind: 'delete-path', path: '/srv/app/obsolete', scope: f.scope };
  const claim = oneShotClaim(structuredFileTargetOf(operation)!);
  const orderedClaim = (target: FileStartTarget): boolean => { f.events.push('claim'); return claim.claim(target); };
  const result = await f.executor.execute(operation, operationFingerprint(operation), undefined,
    { claimFileStart: orderedClaim });
  expect(claim.calls).toEqual([{ hostId: 'host', path: '/srv/app/obsolete', operationKind: 'delete-path' }]);
  expect(f.events).toEqual(['claim', 'delete']); // No read preflight and no read-back for deletions.
  expect(result.status).toBe('succeeded');
  expect(f.deleteFile).toHaveBeenCalledOnce();
});

it('binds an upload to the re-verified local content hash', async () => {
  const f = executorFixture();
  const data = Buffer.from('file-bytes');
  vi.spyOn(LocalFileAccess.prototype, 'read').mockResolvedValue({ data, scope: { path: '/source', kind: 'directory' } });
  const operation: ProposedOperation = { id: 'upload', kind: 'upload', localRoot: '/source', localPath: '/source/file',
    remotePath: '/srv/app/uploaded', size: data.length, contentSha256: sha256(data), scope: f.scope };
  const claim = oneShotClaim(structuredFileTargetOf(operation)!);
  const orderedClaim = (target: FileStartTarget): boolean => { f.events.push('claim'); return claim.claim(target); };
  f.readFileForEdit.mockImplementation(async () => { f.events.push('read-back');
    return { content: data.toString(), bytes: data.length, truncated: false, sha256: sha256(data), mode: 0o644, uid: 1, gid: 1 }; });
  const result = await f.executor.execute(operation, operationFingerprint(operation), undefined,
    { claimFileStart: orderedClaim });
  expect(claim.calls).toEqual([{ hostId: 'host', path: '/srv/app/uploaded', operationKind: 'upload', contentSha256: sha256(data) }]);
  expect(f.events).toEqual(['claim', 'write', 'read-back']); // The local re-read precedes the claim without a remote preflight.
  expect(result.status).toBe('succeeded');
  expect(f.writeFile).toHaveBeenCalledOnce();
});

function gateScope(): ProposedOperation['scope'] {
  return { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: '', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'file write claim' };
}

function gateFixture(operation: ProposedOperation, consume: (options: ExecutionOptions) => void) {
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', { onData() {}, onClose() {}, close() {} } as unknown as RawTerminal, 'task', '/');
  operation.scope.terminalId = terminalId;
  operation.scope.terminalGeneration = 1;
  let seen: ExecutionOptions | undefined;
  const executor = {
    execute: async (op: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> => {
      seen = options;
      consume(options ?? {} as ExecutionOptions);
      return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' };
    },
  };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor, lease: manager,
    evaluator: { evaluate: async () => 'error' }, settings: () => ({ mode: 'ask', revision: 1 }),
    approvals: { requestApproval: async () => true, cancelApproval() {} },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  return { run: gate.execute(operation), seen: () => seen };
}

const writeOperation = (): ProposedOperation => ({ id: 'gw', kind: 'write-file', path: '/srv/app/file', content: 'payload\n', scope: gateScope() });

it('mints a file claim for structured writes and fills the handoff from consumption', async () => {
  const operation = writeOperation();
  const f = gateFixture(operation, (options) => {
    expect(options.claimFileStart).toBeTypeOf('function');
    expect(options.claimFileStart!(structuredFileTargetOf(operation)!)).toBe(true);
  });
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'handed-off', businessStart: 'started' });
});

it('fills not-sent and not-started when a minted file claim is never consumed', async () => {
  const f = gateFixture(writeOperation(), () => {});
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'not-sent', businessStart: 'not-started' });
});

it('refuses a file claim whose binding does not match and marks nothing consumed', async () => {
  const operation = writeOperation();
  const f = gateFixture(operation, (options) => {
    const reviewed = structuredFileTargetOf(operation)!;
    expect(options.claimFileStart!({ ...reviewed, path: '/srv/other/file' })).toBe(false);
    expect(options.claimFileStart!({ ...reviewed, contentSha256: '0'.repeat(64) })).toBe(false); // Closed after the first call.
  });
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ handoff: 'not-sent', businessStart: 'not-started' });
});

it('mints no file claim for controlled transactions, commands, or read-only file kinds', async () => {
  const controlled: ProposedOperation = { id: 'cw', kind: 'write-file', path: '/srv/app/file', content: 'payload\n', scope: gateScope(),
    fileEdit: { version: 1, action: 'apply', transactionId: '01234567-89ab-cdef-0123-456789abcdef',
      expectedMetadataDigest: 'a'.repeat(64), expectedAttributeDigest: 'a'.repeat(64), expectedExecutionUid: 1000, diff: '- old\n+ new\n' } };
  const controlledOutcome = await gateFixture(controlled, (options) => {
    expect(options.claimFileStart).toBeUndefined(); // The controlled route keeps its per-step authorization.
  }).run;
  expect(controlledOutcome.result).not.toMatchObject({ handoff: 'not-sent' }); // No fill without a minted claim.
  const command: ProposedOperation = { id: 'cmd', kind: 'command', command: 'ls /srv/app', executionChannel: 'native-exec', scope: gateScope() };
  await gateFixture(command, (options) => {
    expect(options.claimFileStart).toBeUndefined();
    expect(options.claimStart).toBeTypeOf('function');
  }).run;
  const inspect: ProposedOperation = { id: 'ins', kind: 'inspect-file', path: '/srv/app/file', scope: gateScope() };
  await gateFixture(inspect, (options) => {
    expect(options.claimFileStart).toBeUndefined();
  }).run;
});

it('closes the file claim once the executor attempt has settled', async () => {
  const operation = writeOperation();
  let claim: ((target: FileStartTarget) => boolean) | undefined;
  const f = gateFixture(operation, (options) => { claim = options.claimFileStart; });
  await f.run;
  expect(claim!(structuredFileTargetOf(operation)!)).toBe(false); // Late invocation cannot resurrect the claim.
});
