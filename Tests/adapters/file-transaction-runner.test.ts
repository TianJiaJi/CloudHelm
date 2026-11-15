import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { FileInspection, ProposedOperation } from '@cloudhelm/core';
import { FileTransactionRunner } from '../../packages/adapters/src/file-transaction-runner.js';
import type { SshCommandTerminal } from '../../packages/adapters/src/ssh-command-terminal.js';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'root', loginAs: 'user', terminalId: 't', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'controlled file edit' };
const inspect: Extract<ProposedOperation, { kind: 'inspect-file' }> = { id: 'op', kind: 'inspect-file', path: '/srv/config', privilege: 'root', scope };
class PrivateTerminal {
  data = (_value: string) => {}; exit = (_value?: number) => {}; closed = () => {};
  auth = (_value: { id: string; prompt?: string }) => {}; failure = (_value: any) => {};
  commands: string[] = []; inputs: string[] = []; answers: Array<string | null> = [];
  nonce = ''; packet = ''; stopped = false; needsAuth = false; loseResult = false; corrupt = false;
  onData(fn: typeof this.data) { this.data = fn; } onExit(fn: typeof this.exit) { this.exit = fn; }
  onClose(fn: typeof this.closed) { this.closed = fn; } onAuthentication(fn: typeof this.auth) { this.auth = fn; }
  onExecutionFailure(fn: typeof this.failure) { this.failure = fn; } onDisplay(_fn: unknown) {}
  async execute(command: string, _cwd: string, current: () => boolean, options?: { sudoAuthorization?: boolean }) {
    expect(current()).toBe(true); expect(options?.sudoAuthorization).toBe(true);
    this.commands.push(command); this.nonce = /'([a-f0-9]{32})'$/u.exec(command)![1]!;
    if (this.needsAuth) this.auth({ id: 'c'.repeat(32), prompt: 'trusted sudo challenge' });
    else this.data(JSON.stringify({ ready: this.nonce }) + '\n');
  }
  answerAuthentication(_id: string, value: string | null) {
    this.answers.push(value);
    if (value !== null) this.data(JSON.stringify({ ready: this.nonce }) + '\n');
    return true;
  }
  write(value: string) {
    this.inputs.push(value); this.packet += value;
    if (!this.packet.endsWith('\n')) return;
    const request = JSON.parse(this.packet);
    if (this.loseResult) { this.exit(undefined); return; }
    const text = request.contentBase64 ? Buffer.from(request.contentBase64, 'base64').toString('utf8') : 'port=80\n';
    const snapshot: Omit<FileInspection, 'content'> & { contentBase64: string } = { version: 1, path: request.path, contentBase64: Buffer.from(text).toString('base64'),
      sha256: this.corrupt ? '0'.repeat(64) : digest(text), metadataDigest: 'b'.repeat(64), attributeDigest: 'f'.repeat(64),
      executionUid: 0, uid: 37, gid: 42, mode: 0o640, size: Buffer.byteLength(text), device: '10', inode: '2', commitSupported: true, limitation: '' };
    const response = request.action === 'inspect' ? { status: 'inspected', snapshot } : { status: 'committed', snapshot,
      recovery: { version: 1, directoryId: request.backupTransactionId ?? request.transactionId, path: request.path,
        beforeSha256: request.expectedSha256, beforeMetadataDigest: 'c'.repeat(64), afterSha256: snapshot.sha256, afterMetadataDigest: snapshot.metadataDigest } };
    this.data(JSON.stringify({ nonce: this.nonce, ...response }) + '\n'); this.exit(0);
  }
  close() { if (!this.stopped) { this.stopped = true; this.closed(); } }
}
const runner = (terminal: PrivateTerminal, secret?: ConstructorParameters<typeof FileTransactionRunner>[1]) =>
  new FileTransactionRunner({} as SshTransport, secret, () => terminal as unknown as SshCommandTerminal);
it('keeps payload/results private and sends passwords only to the bound trusted authentication receiver', async () => {
  const terminal = new PrivateTerminal(); terminal.needsAuth = true;
  const secret = vi.fn(async (_operation: unknown, signal: AbortSignal, attempt: number) => { expect(signal.aborted).toBe(false); expect(attempt).toBe(1); return 'synthetic-private-password'; });
  const result = await runner(terminal, secret).run(inspect, () => true);
  expect(result).toMatchObject({ status: 'inspected', snapshot: { content: 'port=80\n', executionUid: 0 } });
  expect(secret).toHaveBeenCalledOnce(); expect(terminal.answers).toEqual(['synthetic-private-password']);
  expect(terminal.commands[0]).toMatch(/^sudo -- \/usr\/bin\/python3 /u);
  expect(terminal.commands.join('')).not.toContain('synthetic-private-password');
  expect(terminal.inputs.join('')).not.toContain('synthetic-private-password');
  expect(terminal.stopped).toBe(true);
});
it('does not ask for a password when the trusted transport does not request one', async () => {
  const terminal = new PrivateTerminal(), secret = vi.fn();
  expect((await runner(terminal, secret).run(inspect, () => true)).status).toBe('inspected');
  expect(secret).not.toHaveBeenCalled();
});
it('cancellation of authentication sends no business payload and cannot change identity', async () => {
  const terminal = new PrivateTerminal(); terminal.needsAuth = true;
  const result = await runner(terminal, async () => null).run(inspect, () => true);
  expect(result).toMatchObject({ status: 'refused', effects: 'none', authenticationFailed: true });
  expect(terminal.inputs).toEqual([]); expect(terminal.commands).toHaveLength(1);
});
it('rejects a malformed or mismatching private content receipt', async () => {
  const terminal = new PrivateTerminal(); terminal.corrupt = true;
  const result = await runner(terminal).run(inspect, () => true);
  expect(result.snapshot).toBeUndefined(); expect(result.status).toBe('refused');
});
it('streams bounded chunks rather than putting file contents in argv, and preserves unknown mutation outcomes', async () => {
  const terminal = new PrivateTerminal(); terminal.loseResult = true;
  const operation: ProposedOperation = { id: 'apply', kind: 'write-file', path: '/srv/config', scope, privilege: 'root',
    content: 'x'.repeat(10000), expectedSha256: digest('old'), fileEdit: { version: 1, action: 'apply',
      transactionId: '11111111-1111-4111-8111-111111111111', expectedExecutionUid: 0,
      expectedMetadataDigest: 'a'.repeat(64), expectedAttributeDigest: 'f'.repeat(64), diff: 'bounded diff' } };
  expect(await runner(terminal).run(operation, () => true)).toMatchObject({ status: 'unknown', effects: 'possible' });
  expect(terminal.inputs.length).toBeGreaterThan(1); expect(terminal.inputs.every((value) => value.length <= 1024)).toBe(true);
  expect(terminal.commands[0]).not.toContain(operation.content);
});
