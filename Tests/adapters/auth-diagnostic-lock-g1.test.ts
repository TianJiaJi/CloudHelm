import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import { HostSerialExecutor, TerminalManager } from '@cloudhelm/application';
import { canOfferSuFallback, operationFingerprint, suPtyCommand, type ProposedOperation } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { openNativeSshPty } from '../../packages/adapters/src/native-ssh-pty.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';

class Channel extends EventEmitter {
  destroyed = false;
  write(_data: Buffer): boolean { return true; }
  close(): void { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  setWindow(): void {}
}

it.each([
  { method: 'sudo', text: 'sudo: user is not allowed to execute this command', code: 1, prompt: true },
  { method: 'sudo', text: '/bin/sh: sudo: not found', code: 127, prompt: true },
  { method: 'sudo', text: 'payload exit 125 without a prompt', code: 125, prompt: false },
  { method: 'sudo', text: 'payload exit 127 without a prompt', code: 127, prompt: false },
  { method: 'su', text: 'su: Authentication failure', code: 1, prompt: true },
  { method: 'su', text: '/bin/sh: su: not found', code: 127, prompt: true }
] as const)('keeps the write lock and refuses su fallback for $method diagnostic exit $code ($text)', async ({ method, text, code, prompt }) => {
  const channel = new Channel();
  const client = { exec: (_command: string, _options: unknown, callback: (error: Error | null, stream: Channel) => void) => callback(null, channel) };
  let nonce = '', challenge = '';
  const transport = { connectionGeneration: () => 1,
    runNativePty: (_host: string, input: Parameters<typeof openNativeSshPty>[1], current: () => boolean,
      hooks: Parameters<typeof openNativeSshPty>[3], signal?: AbortSignal) => {
      nonce = input.nonce;
      return openNativeSshPty(client as unknown as Pick<Client, 'exec'>, input, current, hooks, signal);
    }
  } as unknown as CommandTransport;
  const raw = new SshCommandTerminal(transport, 'host');
  const terminals = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminals.open('host', raw, 'task', '/');
  terminals.subscribeAuthentication(terminalId, (event) => { if (event.prompt) challenge = event.id; });
  const wrapped = method === 'su' ? suPtyCommand(await new BashAnalyzer().analyze('touch /tmp/g1-proof'), '/') : 'sudo touch /tmp/g1-proof';
  if (!wrapped) throw new Error('Invalid synthetic su fixture');
  const operation: ProposedOperation = { id: 'first', kind: 'command', command: wrapped, executionChannel: 'native-pty',
    ...(method === 'su' ? { privilege: 'root' as const } : {}), scope: { taskId: 'task', hostId: 'host', cwd: '/',
      runAs: 'root', terminalId, terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'G1 diagnostic isolation' } };
  const execute = vi.fn(async (candidate: ProposedOperation, fingerprint: string) => candidate.id === 'first'
    ? terminals.execute(candidate, fingerprint)
    : { operationId: candidate.id, status: 'succeeded' as const, exitCode: 0, effects: 'none' as const, stdoutTail: 'fresh observation' });
  const serial = new HostSerialExecutor({ execute });
  const pending = serial.execute(operation, operationFingerprint(operation));
  try {
    await vi.waitFor(() => expect(nonce).toMatch(/^[a-f0-9]{32}$/u));
    if (prompt) {
      channel.emit('data', Buffer.from(method === 'sudo' ? `\rcloudhelm:${nonce} password: ` : `cloudhelm:${nonce}Password: `));
      expect(terminals.answerAuthentication(terminalId, operation.id, challenge, 'synthetic-g1-secret')).toBe(true);
    }
    channel.emit('data', Buffer.from(`\nBusiness has started in this fixture\n${text}\n`));
    channel.emit('exit', code); channel.emit('close');
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', effects: 'possible', exitCode: code });
    expect(canOfferSuFallback(result)).toBe(false);
    if (prompt) expect(result.privilege).toMatchObject({ source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' });
    const next: ProposedOperation = { ...operation, id: 'new-write', scope: { ...operation.scope, taskId: 'other-task' } };
    expect(await serial.execute(next, operationFingerprint(next))).toMatchObject({ failureKind: 'unresolved-prior-operation', effects: 'none' });
    const inspect: ProposedOperation = { ...operation, id: 'inspect', command: 'df -h' };
    expect(await serial.execute(inspect, operationFingerprint(inspect), undefined, { readOnly: true })).toMatchObject({ status: 'succeeded' });
    expect(execute.mock.calls.map(([candidate]) => candidate.id)).toEqual(['first', 'inspect']);
  } finally { raw.close(); await pending.catch(() => {}); }
});
