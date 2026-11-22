import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Client, ClientChannel } from 'ssh2';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import type { NativeStartTarget, ProposedOperation } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { runNativeSshExec } from '../../packages/adapters/src/native-ssh-exec.js';
import { SshTransport } from '../../packages/adapters/src/ssh-transport.js';

class Channel extends EventEmitter {
  readonly stderr = new EventEmitter();
  close(): void { this.emit('close'); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

function fixture(targetChange: Partial<NativeStartTarget> = {}) {
  let now = 1_000_000, hard = 0, claim: (() => boolean) | undefined;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const ready = deferred<{ exitCode: number; output: string }>();
  const channel = new Channel();
  const exec = vi.fn((_command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
    queueMicrotask(() => callback(undefined, channel as unknown as ClientChannel));
  });
  const client = { exec } as unknown as Pick<Client, 'exec'>;
  const execFixed = vi.fn(async () => ready.promise);
  const native = vi.fn(async (_host: string, input: Parameters<typeof runNativeSshExec>[1], current: () => boolean,
    hooks: Omit<Parameters<typeof runNativeSshExec>[3], 'claimStart'> & { claimStart?(target: NativeStartTarget): boolean }, signal?: AbortSignal) => {
    const actual = { hostId: _host, command: input.command, cwd: input.cwd, ...targetChange };
    claim = hooks.claimStart ? () => hooks.claimStart!(actual) : undefined;
    return runNativeSshExec(client, { ...input, command: actual.command, cwd: actual.cwd }, current, { ...hooks, claimStart: claim }, signal);
  });
  const transport = { connectionGeneration: () => 1, execFixed, runNativeExec: native } as unknown as CommandTransport;
  const raw = new SshCommandTerminal(transport, 'host');
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', raw, 'task', '/');
  const operation: ProposedOperation = { id: 'native-claim', kind: 'command', command: 'systemctl restart demo.service', executionChannel: 'native-exec', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'native handoff contract' } };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: manager, lease: manager,
    evaluator: { evaluate: async () => 'error' }, settings: () => ({ mode: 'ask', revision: 1 }),
    approvals: { requestApproval: async (request) => { hard = request.hardExpiresAt!; return true; }, cancelApproval() {} },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  const run = gate.execute(operation);
  return { run, raw, channel, exec, execFixed, native, client, claim: () => claim,
    ready: () => ready.resolve({ exitCode: 0, output: '' }), expire: () => { now = hard; }, rewind: () => { now = 1_000_000; } };
}

it('does not hand off a business command if approval expires during native preflight', async () => {
  const f = fixture();
  try {
    await vi.waitFor(() => expect(f.execFixed).toHaveBeenCalledOnce());
    f.expire(); f.ready();
    expect((await f.run).result).toMatchObject({ status: 'failed', failureKind: 'not-dispatched', effects: 'none' });
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.exec).not.toHaveBeenCalled();
    f.rewind(); // A returned attempt must not resurrect an unused claim even after a wall-clock rollback.
    expect(f.claim()?.()).toBe(false);
  } finally { f.ready(); f.raw.close(); await f.run; }
});

it.each([{ hostId: 'wrong-host' }, { command: 'systemctl stop demo.service' }, { cwd: '/wrong' }])('refuses a mismatched start target %j', async (changed) => {
  const f = fixture(changed);
  try {
    f.ready();
    expect((await f.run).result).toMatchObject({ status: 'failed', failureKind: 'not-dispatched', effects: 'none' });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.claim()?.()).toBe(false);
  } finally { f.ready(); f.raw.close(); await f.run; }
});

it('consumes once at exec and preserves a normal exit after the start window expires', async () => {
  const f = fixture();
  try {
    f.ready();
    await vi.waitFor(() => expect(f.channel.listenerCount('exit')).toBe(1));
    expect(f.exec).toHaveBeenCalledOnce();
    expect(f.claim()).toBeTypeOf('function');
    const replay = await runNativeSshExec(f.client,
      { command: 'systemctl restart demo.service', cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh' },
      () => true, { stdout() {}, stderr() {}, claimStart: f.claim() });
    expect(replay).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
    expect(f.exec).toHaveBeenCalledOnce();
    f.expire();
    f.channel.emit('data', Buffer.from('observed completion'));
    f.channel.emit('exit', 0); f.channel.emit('close');
    expect((await f.run).result).toMatchObject({ status: 'succeeded', exitCode: 0, stdoutTail: 'observed completion' });
    expect(f.claim()?.()).toBe(false);
  } finally { f.ready(); f.raw.close(); await f.run; }
});

it('matches the actual host, command and directory in the production transport before SSH handoff', async () => {
  const exec = vi.fn();
  const client = { exec };
  const transport = { connections: new Map([['actual-host', client]]), connectionGeneration: () => 1 } as unknown as SshTransport;
  const claimStart = vi.fn(() => false);
  const result = await SshTransport.prototype.runNativeExec.call(transport, 'actual-host',
    { command: 'id', cwd: '/actual', envPath: '/usr/bin/env', shellPath: '/bin/sh' }, () => true,
    { stdout() {}, stderr() {}, claimStart });
  expect(claimStart).toHaveBeenCalledExactlyOnceWith({ hostId: 'actual-host', command: 'id', cwd: '/actual' });
  expect(result).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  expect(exec).not.toHaveBeenCalled();
});

it('does not call SSH when a start claim throws', async () => {
  const exec = vi.fn();
  const result = await runNativeSshExec({ exec } as unknown as Pick<Client, 'exec'>,
    { command: 'id', cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh' }, () => true,
    { stdout() {}, stderr() {}, claimStart: () => { throw new Error('private synthetic failure'); } });
  expect(result).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  expect(exec).not.toHaveBeenCalled();
});
