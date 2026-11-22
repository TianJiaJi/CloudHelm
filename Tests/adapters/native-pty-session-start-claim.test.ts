import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Client, ClientChannel } from 'ssh2';
import { SafetyGate, TerminalManager } from '@cloudhelm/application';
import type { ExecutionOptions, NativeStartTarget, OperationResult, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
import { openNativeSshPty, type NativePtyOutcome } from '../../packages/adapters/src/native-ssh-pty.js';
import { NativeSessionTerminal, type SessionTransport, type SudoSessionChannel } from '../../packages/adapters/src/native-session-terminal.js';

afterEach(() => vi.restoreAllMocks());

const ptyInput = { command: "sudo -k -p 'marker' id", cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh',
  nonce: 'a'.repeat(32), cols: 100, rows: 30 };

it('claims immediately before the PTY exec and fails closed on a denied or throwing claim', async () => {
  const exec = vi.fn();
  const denied = openNativeSshPty({ exec } as unknown as Pick<Client, 'exec'>, ptyInput, () => true,
    { data() {}, authentication() {}, claimStart: () => false });
  expect(await denied.result).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  const threw = openNativeSshPty({ exec } as unknown as Pick<Client, 'exec'>, ptyInput, () => true,
    { data() {}, authentication() {}, claimStart: () => { throw new Error('private synthetic failure'); } });
  expect(await threw.result).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  expect(exec).not.toHaveBeenCalled();
});

it('dispatches the PTY when the caller supplies no claim hook', async () => {
  const stream = new EventEmitter();
  const exec = vi.fn((_command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
    queueMicrotask(() => { callback(undefined, stream as unknown as ClientChannel); stream.emit('exit', 0); stream.emit('close'); });
  });
  const handle = openNativeSshPty({ exec } as unknown as Pick<Client, 'exec'>, ptyInput, () => true,
    { data() {}, authentication() {} });
  expect(await handle.result).toEqual({ state: 'exited', exitCode: 0, markerSeen: false, sudoMissing: false });
  expect(exec).toHaveBeenCalledExactlyOnceWith(expect.any(String),
    expect.objectContaining({ pty: expect.objectContaining({ term: 'dumb' }) }), expect.any(Function));
});

function ptyTerminal() {
  let transportClaim: ((target: NativeStartTarget) => boolean) | undefined;
  const runNativePty = vi.fn((_hostId: string, input: { command: string; cwd: string }, _current: () => boolean,
    hooks: { data(text: string): void; authentication(event: { id: string; open: boolean }): void; claimStart?(target: NativeStartTarget): boolean },
    _signal?: AbortSignal) => {
    transportClaim = hooks.claimStart;
    return { result: Promise.resolve<NativePtyOutcome>({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false }),
      answer: () => false, write() {}, resize() {} };
  });
  const transport = { connectionGeneration: () => 1, runNativePty } as unknown as CommandTransport;
  return { terminal: new SshCommandTerminal(transport, 'host'), runNativePty, transportClaim: () => transportClaim! };
}

it('rebinds the reviewed command and directory for the PTY claim', async () => {
  let claimed = false;
  const gateClaim = vi.fn((_target: NativeStartTarget) => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
  const f = ptyTerminal();
  await f.terminal.execute('sudo id', '/srv', () => true, { executionChannel: 'native-pty', claimStart: gateClaim });
  const input = f.runNativePty.mock.calls[0]![1];
  expect(input.command).toMatch(/^sudo -k -p '/u); // The dispatch text is the rebuilt sudo form.
  const claim = f.transportClaim();
  expect(claim({ hostId: 'host', command: input.command, cwd: '/srv' })).toBe(true);
  expect(gateClaim).toHaveBeenCalledExactlyOnceWith({ hostId: 'host', command: 'sudo id', cwd: '/srv' });
  expect(claim({ hostId: 'host', command: input.command, cwd: '/srv' })).toBe(false); // Single use.
});

it('refuses a PTY claim whose dispatch binding does not match', async () => {
  const gateClaim = vi.fn(() => true);
  const f = ptyTerminal();
  await f.terminal.execute('sudo id', '/srv', () => true, { executionChannel: 'native-pty', claimStart: gateClaim });
  const claim = f.transportClaim();
  const input = f.runNativePty.mock.calls[0]![1];
  expect(claim({ hostId: 'other-host', command: input.command, cwd: '/srv' })).toBe(false);
  expect(claim({ hostId: 'host', command: 'sudo rm -rf /', cwd: '/srv' })).toBe(false);
  expect(claim({ hostId: 'host', command: input.command, cwd: '/' })).toBe(false);
  expect(gateClaim).not.toHaveBeenCalled();
});

it('binds the PTY dispatch target in the production transport before SSH handoff', async () => {
  const exec = vi.fn();
  const client = { exec };
  const transport = { connections: new Map([['actual-host', client]]), connectionGeneration: () => 1 } as unknown as SshTransport;
  const claimStart = vi.fn(() => false);
  const handle = SshTransport.prototype.runNativePty.call(transport, 'actual-host',
    { command: "sudo -k -p 'marker' id", cwd: '/actual', envPath: '/usr/bin/env', shellPath: '/bin/sh',
      nonce: 'a'.repeat(32), cols: 100, rows: 30 },
    () => true, { data() {}, authentication() {}, claimStart });
  expect(claimStart).toHaveBeenCalledExactlyOnceWith({ hostId: 'actual-host', command: "sudo -k -p 'marker' id", cwd: '/actual' });
  expect(await handle.result).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  expect(exec).not.toHaveBeenCalled();
});

const sudoChannel: SudoSessionChannel = { credential: async () => 'session-password', rejected: () => {} };

function sessionTerminal(sudo?: SudoSessionChannel) {
  let claimed = false;
  const gateClaim = vi.fn(() => { if (claimed) return false; claimed = true; return true; });
  let transportClaim: ((target: NativeStartTarget) => boolean) | undefined;
  let dispatch: NativeStartTarget | undefined;
  const runNativeExec = vi.fn(async (host: string, input: { command: string; cwd: string }, _current: () => boolean,
    hooks: { claimStart?(target: NativeStartTarget): boolean }, _signal?: AbortSignal) => {
    transportClaim = hooks.claimStart;
    dispatch = { hostId: host, command: input.command, cwd: input.cwd };
    return { state: 'exited' as const, exitCode: 0 };
  });
  const transport = { connectionGeneration: () => 1, execFixed: vi.fn(async () => ({ exitCode: 0, output: '' })),
    runNativeExec } as unknown as SessionTransport;
  return { terminal: new NativeSessionTerminal(transport, 'host', sudo), runNativeExec, gateClaim,
    transportClaim: () => transportClaim!, dispatch: () => dispatch! };
}

it('rebinds the reviewed command and directory for the session claim', async () => {
  const f = sessionTerminal(sudoChannel);
  await f.terminal.execute('sudo id', '/srv', () => true, { claimStart: f.gateClaim });
  expect(f.dispatch().command).toMatch(/^sudo -k -S -p '/u); // The dispatch text is the rebuilt stdin form.
  expect(f.transportClaim()(f.dispatch())).toBe(true);
  expect(f.gateClaim).toHaveBeenCalledExactlyOnceWith({ hostId: 'host', command: 'sudo id', cwd: '/srv' });
  expect(f.transportClaim()(f.dispatch())).toBe(false); // Single use.
});

it('refuses a session claim whose dispatch binding does not match', async () => {
  const f = sessionTerminal(sudoChannel);
  await f.terminal.execute('sudo id', '/srv', () => true, { claimStart: f.gateClaim });
  const claim = f.transportClaim();
  expect(claim({ hostId: 'host', command: 'sudo id', cwd: '/srv' })).toBe(false); // Reviewed text is not the dispatch text.
  expect(claim({ hostId: 'host', command: f.dispatch().command, cwd: '/etc' })).toBe(false);
  expect(claim({ hostId: 'other', command: f.dispatch().command, cwd: '/srv' })).toBe(false);
  expect(f.gateClaim).not.toHaveBeenCalled();
});

it('claims the verbatim root-login session dispatch', async () => {
  const f = sessionTerminal();
  await f.terminal.execute('id -u', '/root', () => true, { claimStart: f.gateClaim });
  expect(f.dispatch()).toEqual({ hostId: 'host', command: 'id -u', cwd: '/root' });
  expect(f.transportClaim()(f.dispatch())).toBe(true);
  expect(f.gateClaim).toHaveBeenCalledExactlyOnceWith({ hostId: 'host', command: 'id -u', cwd: '/root' });
});

function gateFixture(operation: ProposedOperation, consumeClaim: boolean) {
  let now = 1_000_000, hard = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', { onData() {}, onDisplay() {}, onExecutionFailure() {}, onExit() {},
    onAuthentication() {}, onClose() {}, execute: async () => {}, write() {}, resize() {}, close() {} } as unknown as RawTerminal, 'task', '/');
  operation.scope.terminalId = terminalId;
  operation.scope.terminalGeneration = 1;
  let seen: ExecutionOptions | undefined;
  const executor = {
    execute: async (op: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> => {
      seen = options;
      if (consumeClaim) options?.claimStart?.({ hostId: op.scope.hostId, command: op.kind === 'command' ? op.command : '', cwd: op.scope.cwd });
      return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' };
    },
  };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor, lease: manager,
    evaluator: { evaluate: async () => 'error' }, settings: () => ({ mode: 'ask', revision: 1 }),
    approvals: { requestApproval: async (request) => { hard = request.hardExpiresAt!; return true; }, cancelApproval() {} },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  return { run: gate.execute(operation), seen: () => seen, expire: () => { now = hard; } };
}

function scope(): ProposedOperation['scope'] {
  return { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: '', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'start claim minting' };
}

it('mints and fills the start claim for a native-pty command', async () => {
  const f = gateFixture({ id: 'pty-claim', kind: 'command', command: 'sudo systemctl restart nginx',
    executionChannel: 'native-pty', scope: scope() }, true);
  const outcome = await f.run;
  expect(typeof f.seen()?.claimStart).toBe('function');
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'handed-off', businessStart: 'started' });
});

it('mints and fills the start claim for a session command without an execution channel', async () => {
  const f = gateFixture({ id: 'session-claim', kind: 'command', command: 'sudo cat /root/test/test.py',
    scope: { ...scope(), sessionId: 'sess-1' } }, true);
  const outcome = await f.run;
  expect(typeof f.seen()?.claimStart).toBe('function');
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'handed-off', businessStart: 'started' });
});

it('does not mint a start claim for process control and leaves the result unfilled', async () => {
  const f = gateFixture({ id: 'kill-claim', kind: 'command', command: 'kill -INT -- -4321',
    processControl: { kind: 'interrupt', jobId: 'job-1', targetOperationId: 'op-1', pid: 4321, processSequence: 1, connectionId: 'conn-1' },
    scope: scope() }, true);
  const outcome = await f.run;
  expect(f.seen()?.claimStart).toBeUndefined();
  expect(outcome.result).not.toHaveProperty('handoff');
  expect(outcome.result).not.toHaveProperty('businessStart');
});

it('fills not-sent and not-started when a minted claim is never consumed', async () => {
  const f = gateFixture({ id: 'unclaimed', kind: 'command', command: 'sudo systemctl restart nginx',
    executionChannel: 'native-pty', scope: scope() }, false);
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'not-sent', businessStart: 'not-started' });
});

function ptyGateFixture(expireBeforeClaim: boolean) {
  let now = 1_000_000, hard = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const channel = new EventEmitter();
  const exec = vi.fn((_command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
    queueMicrotask(() => callback(undefined, channel as unknown as ClientChannel));
  });
  const client = { exec } as unknown as Pick<Client, 'exec'>;
  let claim: ((target: NativeStartTarget) => boolean) | undefined;
  const runNativePty = vi.fn((hostId: string, input: { command: string; cwd: string; envPath: string; shellPath: string; nonce: string; cols: number; rows: number },
    current: () => boolean,
    hooks: { data(text: string): void; authentication(event: { id: string; open: boolean }): void; claimStart?(target: NativeStartTarget): boolean },
    signal?: AbortSignal) => {
    claim = hooks.claimStart;
    if (expireBeforeClaim) now = hard;
    return openNativeSshPty(client, input, current, { data: hooks.data, authentication: hooks.authentication,
      claimStart: hooks.claimStart ? () => hooks.claimStart!({ hostId: hostId, command: input.command, cwd: input.cwd }) : undefined }, signal);
  });
  const transport = { connectionGeneration: () => 1, runNativePty } as unknown as CommandTransport;
  const raw = new SshCommandTerminal(transport, 'host');
  const manager = new TerminalManager({ data() {}, state() {} });
  const terminalId = manager.open('host', raw, 'task', '/');
  const operation: ProposedOperation = { id: 'pty-chain', kind: 'command', command: 'sudo systemctl restart nginx',
    executionChannel: 'native-pty', scope: { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId,
      terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'pty handoff contract' } };
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: manager, lease: manager,
    evaluator: { evaluate: async () => 'error' }, settings: () => ({ mode: 'ask', revision: 1 }),
    approvals: { requestApproval: async (request) => { hard = request.hardExpiresAt!; return true; }, cancelApproval() {} },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  return { run: gate.execute(operation), raw, channel, exec, runNativePty, client,
    claim: () => claim!, dispatch: () => runNativePty.mock.calls[0]![1] as { command: string; cwd: string },
    expire: () => { now = hard; }, rewind: () => { now = 1_000_000; } };
}

it('does not hand off a business command if approval expires before the PTY claim', async () => {
  const f = ptyGateFixture(true);
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'failed', failureKind: 'not-dispatched', effects: 'none',
    handoff: 'not-sent', businessStart: 'not-started' });
  expect(f.runNativePty).toHaveBeenCalledOnce();
  expect(f.exec).not.toHaveBeenCalled();
  f.rewind(); // A returned attempt must not resurrect an unused claim even after a wall-clock rollback.
  expect(f.claim()({ hostId: 'host', command: f.dispatch().command, cwd: '/' })).toBe(false);
  f.raw.close();
});

it('consumes once at the PTY dispatch and preserves a normal exit after the start window expires', async () => {
  const f = ptyGateFixture(false);
  await vi.waitFor(() => expect(f.channel.listenerCount('exit')).toBe(1));
  expect(f.exec).toHaveBeenCalledOnce();
  f.channel.emit('exit', 0);
  f.channel.emit('close');
  const outcome = await f.run;
  expect(outcome.result).toMatchObject({ status: 'succeeded', exitCode: 0, handoff: 'handed-off', businessStart: 'started' });
  f.expire();
  expect(f.claim()({ hostId: 'host', command: f.dispatch().command, cwd: '/' })).toBe(false);
  f.raw.close();
});
