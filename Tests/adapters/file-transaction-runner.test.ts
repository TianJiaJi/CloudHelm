import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { SFTPWrapper, Stats } from 'ssh2';
import { fileAttributeDigest, fileMetadataDigest, type ProposedOperation } from '@cloudhelm/core';
import { FileTransactionRunner, validFileRecovery } from '../../packages/adapters/src/file-transaction-runner.js';
import type { SshCommandTerminal } from '../../packages/adapters/src/ssh-command-terminal.js';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const UUID = '11111111-1111-4111-8111-111111111111';
const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', loginAs: 'user', terminalId: 't', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'controlled file edit' };
const configMeta = fileMetadataDigest({ size: 8, mode: 0o640, uid: 37, gid: 42, mtimeSec: 100 });
const configAttr = fileAttributeDigest({ uid: 37, gid: 42, mode: 0o640 });
const applyOperation: Extract<ProposedOperation, { kind: 'write-file' }> = { id: 'apply', kind: 'write-file', path: '/srv/config', scope,
  content: 'port=90\n', expectedSha256: hash('port=80\n'),
  fileEdit: { version: 1, action: 'apply', transactionId: UUID, expectedMetadataDigest: configMeta,
    expectedAttributeDigest: configAttr, expectedExecutionUid: 37, diff: 'bounded diff' } };

interface FakeEntry { kind: 'dir' | 'file'; content?: Buffer; uid: number; gid: number; mode: number; mtime: number }
type Reply = { exitCode?: number; output?: string; fail?: 'not-dispatched' | 'unknown' };

/** In-memory remote host: the SFTP subset both routes use, plus the literal
 * ln/mv/rm/rmdir side effects of native file commands. */
class FakeHost {
  generation = 1;
  sftpBroken = false;
  sftpSessions = 0;
  closed = false;
  readonly commands: string[] = [];
  plan: (command: string) => Reply = () => ({ exitCode: 1 });
  readonly entries = new Map<string, FakeEntry>([
    ['/', { kind: 'dir', uid: 0, gid: 0, mode: 0o755, mtime: 0 }],
    ['/srv', { kind: 'dir', uid: 0, gid: 0, mode: 0o755, mtime: 0 }],
    ['/srv/config', { kind: 'file', content: Buffer.from('port=80\n'), uid: 37, gid: 42, mode: 0o640, mtime: 100 }],
  ]);

  private statOf(entry: FakeEntry): Stats {
    return { size: entry.kind === 'file' ? entry.content!.length : 0, uid: entry.uid, gid: entry.gid, mode: entry.mode, mtime: entry.mtime,
      isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => false } as unknown as Stats;
  }

  readonly sftp = {
    lstat: (remotePath: string, done: (error: unknown, stat?: Stats) => void) => {
      const entry = this.entries.get(remotePath);
      if (entry) done(null, this.statOf(entry)); else done({ code: 2 });
    },
    mkdir: (remotePath: string, attrs: { mode?: number }, done: (error: unknown) => void) => {
      if (this.entries.has(remotePath)) done({ code: 4 });
      else { this.entries.set(remotePath, { kind: 'dir', uid: 37, gid: 37, mode: (attrs.mode ?? 0o755) & 0o7777, mtime: 150 }); done(null); }
    },
    writeFile: (remotePath: string, content: Buffer, options: { mode?: number }, done: (error: unknown) => void) => {
      if (this.entries.has(remotePath)) done({ code: 4 });
      else { this.entries.set(remotePath, { kind: 'file', content: Buffer.from(content), uid: 37, gid: 37,
        mode: (options.mode ?? 0o600) & 0o7777, mtime: 200 }); done(null); }
    },
    setstat: (remotePath: string, attrs: { uid?: number; gid?: number; mode?: number }, done: (error: unknown) => void) => {
      const entry = this.entries.get(remotePath);
      if (!entry) done({ code: 2 });
      else {
        if (attrs.uid !== undefined) entry.uid = attrs.uid;
        if (attrs.gid !== undefined) entry.gid = attrs.gid;
        if (attrs.mode !== undefined) entry.mode = attrs.mode & 0o7777;
        done(null);
      }
    },
    readdir: (remotePath: string, done: (error: unknown, list?: Array<{ filename: string; attrs: Stats }>) => void) => {
      const prefix = remotePath === '/' ? '/' : `${remotePath}/`;
      const entry = this.entries.get(remotePath);
      if (entry?.kind !== 'dir') { done({ code: 2 }); return; }
      const list = [...this.entries.entries()]
        .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
        .map(([name, item]) => ({ filename: name.slice(prefix.length), attrs: this.statOf(item) }));
      done(null, list);
    },
    unlink: (remotePath: string, done: (error: unknown) => void) => { this.entries.delete(remotePath); done(null); },
    rmdir: (remotePath: string, done: (error: unknown) => void) => {
      if ([...this.entries.keys()].some((name) => name.startsWith(`${remotePath}/`))) done({ code: 11 });
      else if (this.entries.delete(remotePath)) done(null); else done({ code: 2 });
    },
    open: (remotePath: string, _flag: string, done: (error: unknown, handle?: Buffer) => void) => {
      const entry = this.entries.get(remotePath);
      if (entry?.kind === 'file') done(null, Buffer.from(remotePath)); else done({ code: 2 });
    },
    fstat: (handle: Buffer, done: (error: unknown, stat?: Stats) => void) => {
      const entry = this.entries.get(handle.toString('utf8'));
      if (entry?.kind === 'file') done(null, this.statOf(entry)); else done({ code: 2 });
    },
    read: (handle: Buffer, buffer: Buffer, bufferOffset: number, length: number, position: number,
      done: (error: unknown, bytesRead?: number) => void) => {
      const content = this.entries.get(handle.toString('utf8'))?.content;
      if (!content) { done({ code: 2 }); return; }
      const chunk = content.subarray(position, position + length);
      chunk.copy(buffer, bufferOffset);
      done(null, chunk.length);
    },
    close: (_handle: Buffer, done: (error: unknown) => void) => done(null),
  } as unknown as SFTPWrapper;

  private data = (_text: string) => {};
  private exit = (_code?: number) => {};
  private failure = (_value: { failureKind?: string; effects?: string }) => {};

  connectionGeneration(): number { return this.generation; }
  async withSftpSession<T>(_hostId: string, action: (sftp: SFTPWrapper, assertActive: () => void) => Promise<T>): Promise<T> {
    this.sftpSessions++;
    if (this.sftpBroken) throw new Error('SFTP subsystem unavailable');
    return action(this.sftp, () => {});
  }
  onDisplay(_fn: unknown): void {}
  onData(fn: (text: string) => void): void { this.data = fn; }
  onExecutionFailure(fn: (value: { failureKind?: string; effects?: string }) => void): void { this.failure = fn; }
  onExit(fn: (code?: number) => void): void { this.exit = fn; }
  async execute(command: string, _cwd: string, current: () => boolean, options?: { executionChannel?: string }): Promise<void> {
    this.commands.push(command);
    if (options?.executionChannel !== 'native-exec') throw new Error('unexpected execution channel');
    const reply = this.plan(command);
    if (!current() || reply.fail === 'not-dispatched') { this.failure({ failureKind: 'not-dispatched', effects: 'none' }); return; }
    const quoted = [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1]!);
    if (command.startsWith('ln -- ') && quoted.length === 2) {
      const source = this.entries.get(quoted[0]!);
      if (source) this.entries.set(quoted[1]!, { ...source, content: source.content?.subarray() });
    } else if (command.startsWith('mv -- ') && quoted.length === 2) {
      const entry = this.entries.get(quoted[0]!);
      if (entry) { this.entries.delete(quoted[0]!); this.entries.set(quoted[1]!, entry); }
    } else if (/^rm -f -- /u.test(command)) {
      this.entries.delete(quoted[0]!);
    } else if (command.startsWith('rmdir -- ')) {
      if (!this.entries.has(quoted[0]!) || [...this.entries.keys()].some((name) => name.startsWith(`${quoted[0]}/`))) {
        this.data('rmdir: not empty\n'); this.exit(1); return;
      }
      this.entries.delete(quoted[0]!);
    }
    if (reply.fail === 'unknown') return;
    if (reply.output !== undefined) this.data(reply.output);
    this.exit(reply.exitCode ?? 0);
  }
  close(): void { this.closed = true; }
}

const runner = (host: FakeHost) => new FileTransactionRunner(host as unknown as SshTransport,
  () => host as unknown as SshCommandTerminal);
const inspect: Extract<ProposedOperation, { kind: 'inspect-file' }> = { id: 'inspect', kind: 'inspect-file', path: '/srv/config', scope };
const identityPlan = (host: FakeHost, fail?: Reply['fail']): void => {
  host.plan = (command) => command === 'id -u' ? fail ? { fail } : { exitCode: 0, output: '37\n' } : { exitCode: 0 };
};

it('probes the execution identity once and inspects through SFTP with a locally computed snapshot', async () => {
  const host = new FakeHost();
  identityPlan(host);
  const result = await runner(host).run(inspect, () => true);
  expect(result).toMatchObject({ status: 'inspected', snapshot: { version: 2, content: 'port=80\n', sha256: hash('port=80\n'),
    metadataDigest: configMeta, attributeDigest: configAttr, uid: 37, gid: 42, mode: 0o640, executionUid: 37,
    commitSupported: true, limitation: '' } });
  expect(host.commands).toEqual(['id -u']);
  expect(host.sftpSessions).toBe(2); // capability probe plus the inspection itself
});

it('commits an approved replacement through staging, hard-link backup and atomic rename', async () => {
  const host = new FakeHost();
  identityPlan(host);
  const result = await runner(host).run(applyOperation, () => true);
  expect(result.status).toBe('committed');
  expect(result.snapshot).toMatchObject({ version: 2, content: 'port=90\n', sha256: hash('port=90\n'), uid: 37, gid: 42, mode: 0o640 });
  expect(result.recovery).toMatchObject({ directoryId: UUID, path: '/srv/config', beforeSha256: hash('port=80\n'),
    beforeMetadataDigest: configMeta, afterSha256: hash('port=90\n') });
  expect(host.entries.get('/srv/config')?.content?.toString()).toBe('port=90\n');
  expect(host.entries.get(`/srv/config.cloudhelm-backup-${UUID}`)?.content?.toString()).toBe('port=80\n');
  expect(host.entries.has(`/srv/.cloudhelm-edit-${UUID}`)).toBe(false); // staging removed after commit
  expect(host.commands).toEqual(['id -u', expect.stringMatching(/^ln -- /u), expect.stringMatching(/^mv -- /u)]);
});

it('refuses when the reviewed source no longer matches, leaving the host untouched', async () => {
  const host = new FakeHost();
  identityPlan(host);
  const result = await runner(host).run({ ...applyOperation, expectedSha256: hash('different content\n') }, () => true);
  expect(result).toMatchObject({ status: 'refused', effects: 'none', code: 'source-version-or-metadata-changed' });
  expect(host.commands).toEqual(['id -u']);
  expect(host.entries.get('/srv/config')?.content?.toString()).toBe('port=80\n');
  expect([...host.entries.keys()].filter((name) => name.includes('cloudhelm-'))).toEqual([]);
});

it('keeps an unknown commit step unverified and never replays it', async () => {
  const host = new FakeHost();
  host.plan = (command) => command === 'id -u' ? { exitCode: 0, output: '37\n' }
    : command.startsWith('ln -- ') ? { fail: 'unknown' } : { exitCode: 0 };
  expect(await runner(host).run(applyOperation, () => true))
    .toMatchObject({ status: 'unknown', effects: 'possible', code: 'commit-outcome-unknown' });
});

it('rolls staged artifacts back when publication cannot be dispatched', async () => {
  const host = new FakeHost();
  host.plan = (command) => command === 'id -u' ? { exitCode: 0, output: '37\n' }
    : command.startsWith('mv -- ') ? { fail: 'not-dispatched' } : { exitCode: 0 };
  const result = await runner(host).run(applyOperation, () => true);
  expect(result).toMatchObject({ status: 'refused', effects: 'none', code: 'commit-not-dispatched' });
  expect(host.entries.get('/srv/config')?.content?.toString()).toBe('port=80\n');
  expect([...host.entries.keys()].filter((name) => name.includes('cloudhelm-')).sort()).toEqual([]);
});

it('degrades to literal shell inspection when SFTP is unavailable', async () => {
  const host = new FakeHost();
  host.sftpBroken = true;
  host.plan = (command) => {
    if (command === 'id -u') return { exitCode: 0, output: '37\n' };
    if (command.startsWith('stat ')) return { exitCode: 0, output: '8|81a0|37|42|100\n' };
    if (command.startsWith('sha256sum ')) return { exitCode: 0, output: `${hash('port=80\n')}  /srv/config\n` };
    if (command.startsWith('head -c ')) return { exitCode: 0, output: 'port=80\n' };
    return { exitCode: 1 };
  };
  const result = await runner(host).run(inspect, () => true);
  expect(result).toMatchObject({ status: 'inspected', snapshot: { version: 2, content: 'port=80\n', uid: 37, gid: 42, mode: 0o640,
    executionUid: 37, commitSupported: false, limitation: 'sftp-required-for-controlled-writes' } });
  expect(host.commands[0]).toBe('id -u');
  expect(host.commands.some((command) => command.startsWith('stat -c '))).toBe(true);
  expect(host.commands.some((command) => command.startsWith('sha256sum '))).toBe(true);
  expect(host.commands.some((command) => command.startsWith('head -c '))).toBe(true);
});

it('refuses controlled writes on hosts without SFTP before any remote effect', async () => {
  const host = new FakeHost();
  host.sftpBroken = true;
  identityPlan(host);
  expect(await runner(host).run(applyOperation, () => true))
    .toMatchObject({ status: 'refused', effects: 'none', code: 'sftp-required-for-controlled-writes' });
  expect(host.commands).toEqual([]);
  expect(host.sftpSessions).toBe(1); // only the capability probe
});

it('refuses a claimed root transaction when the execution identity is not root', async () => {
  const host = new FakeHost();
  identityPlan(host);
  expect(await runner(host).run({ ...applyOperation, privilege: 'root' }, () => true))
    .toMatchObject({ status: 'refused', effects: 'none', code: 'root-identity-unconfirmed' });
  expect(host.commands).toEqual(['id -u']);
});

it('refuses when the execution identity cannot be observed', async () => {
  const host = new FakeHost();
  identityPlan(host, 'not-dispatched');
  expect(await runner(host).run(inspect, () => true))
    .toMatchObject({ status: 'refused', effects: 'none', code: 'execution-identity-unavailable' });
});

it('caches capability and identity probes per connection generation', async () => {
  const host = new FakeHost();
  identityPlan(host);
  const instance = runner(host);
  await instance.run(inspect, () => true);
  await instance.run(inspect, () => true);
  expect(host.commands).toEqual(['id -u']);
  expect(host.sftpSessions).toBe(3); // probe plus two inspections
  host.generation = 2;
  await instance.run(inspect, () => true);
  expect(host.commands).toEqual(['id -u', 'id -u']);
  expect(host.sftpSessions).toBe(5); // re-probe plus the third inspection
});

it('refuses before any probe when authorization has already expired', async () => {
  const host = new FakeHost();
  identityPlan(host);
  expect(await runner(host).run(applyOperation, () => false))
    .toMatchObject({ status: 'refused', effects: 'none', code: 'authorization-expired' });
  expect(host.commands).toEqual([]);
  expect(host.sftpSessions).toBe(0);
});

it('validates the structural shape of recovery receipts', () => {
  const recovery = { version: 1, directoryId: UUID, path: '/srv/config', beforeSha256: hash('a'), beforeMetadataDigest: hash('b'),
    afterSha256: hash('c'), afterMetadataDigest: hash('d') };
  expect(validFileRecovery(recovery, '/srv/config')).toBe(true);
  expect(validFileRecovery({ ...recovery, version: 2 }, '/srv/config')).toBe(false);
  expect(validFileRecovery({ ...recovery, directoryId: 'not-a-uuid' }, '/srv/config')).toBe(false);
  expect(validFileRecovery(recovery, '/other/path')).toBe(false);
  expect(validFileRecovery(null)).toBe(false);
});
