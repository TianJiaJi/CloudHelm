import { expect, it, vi } from 'vitest';
import { HostSerialExecutor, SafetyGate, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type ExecutionOptions, type OperationResult, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';

const operation = (id: string, terminalId = 'terminal'): ProposedOperation => ({ id, kind: 'command',
  command: 'systemctl restart demo.service', scope: { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user',
    terminalId, terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'entry contract' } });
const completed = (id: string): OperationResult => ({ operationId: id, status: 'succeeded', exitCode: 0, effects: 'none', stdoutTail: '' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('rechecks approval time after the gate has handed off to a blocked host queue', async () => {
  let now = 1_000_000, hard = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const blocker = deferred<OperationResult>(), enqueued = deferred<void>();
  const execute = vi.fn(async (op: ProposedOperation) => op.id === 'blocking' ? blocker.promise : completed(op.id));
  const host = new HostSerialExecutor({ execute });
  let options: ExecutionOptions | undefined;
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw,
      calls: [{ name: 'systemctl', args: ['restart', 'demo.service'], dynamic: false, redirects: false }],
      redirectTargets: [], hasError: false, hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false }) },
    evaluator: { evaluate: async () => 'error' },
    approvals: { requestApproval: async (request) => { hard = request.hardExpiresAt!; return true; }, cancelApproval() {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ask', revision: 1 }),
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    executor: { execute: (op, fingerprint, signal, supplied) => {
      options = supplied; enqueued.resolve(); return host.execute(op, fingerprint, signal, supplied);
    } }
  });
  const blocking = host.execute(operation('blocking'), 'synthetic-fingerprint');
  let pending: ReturnType<typeof gate.execute> | undefined;
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    pending = gate.execute(operation('queued'));
    await enqueued.promise;
    now = hard;
    expect(options?.isAuthorized?.()).toBe(true); // Ongoing context is not an approval deadline.
    expect(options?.canEnterExecutor?.()).toBe(false);
    blocker.resolve(completed('blocking')); await blocking;
    expect((await pending).result).toMatchObject({ status: 'failed', failureKind: 'not-dispatched', effects: 'none' });
    expect(execute.mock.calls.map(([op]) => op.id)).toEqual(['blocking']);
    expect((await host.execute(operation('later'), 'synthetic-fingerprint')).status).toBe('succeeded');
  } finally { blocker.resolve(completed('blocking')); await blocking; await pending; clock.mockRestore(); }
});

it.each(['false', 'throw'] as const)('a %s entry guard cannot dispatch or strand the host queue', async (kind) => {
  const execute = vi.fn(async (op: ProposedOperation) => completed(op.id));
  const host = new HostSerialExecutor({ execute });
  const first = operation('first');
  const result = await host.execute(first, operationFingerprint(first), undefined, { canEnterExecutor: () => {
    if (kind === 'throw') throw new Error('synthetic private failure');
    return false;
  } });
  expect(result).toMatchObject({ failureKind: 'not-dispatched', effects: 'none' });
  expect(result.stdoutTail).not.toContain('synthetic private failure');
  expect(execute).not.toHaveBeenCalled();
  expect((await host.execute(operation('later'), 'synthetic-fingerprint')).status).toBe('succeeded');
});

function terminalFixture() {
  let data = (_value: string) => {}, exit = (_code: number | undefined) => {};
  const execute = vi.fn(async () => {});
  const raw: RawTerminal = { execute, write() {}, close() {}, resize() {}, onClose() {},
    onData: (listener) => { data = listener; }, onExit: (listener) => { exit = listener; } };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const id = terminal.open('host', raw, 'task', '/');
  return { terminal, execute, op: operation('terminal-op', id), finish: () => { data('observed exit'); exit(0); } };
}

it.each(['false', 'throw'] as const)('rejects a %s guard before terminal handoff without losing ownership', async (kind) => {
  const f = terminalFixture();
  const result = await f.terminal.execute(f.op, operationFingerprint(f.op), undefined, { canEnterExecutor: () => {
    if (kind === 'throw') throw new Error('synthetic private failure');
    return false;
  } });
  expect(result).toMatchObject({ status: 'failed', failureKind: 'not-dispatched', effects: 'none' });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.terminal.hasPending(f.op.scope.terminalId)).toBe(false);
  expect(f.terminal.isAgentOwner(f.op.scope.terminalId)).toBe(true);
});

it('does not turn observed exit into unknown just because the entry window elapsed after start', async () => {
  const f = terminalFixture(); let admitted = true;
  const pending = f.terminal.execute(f.op, operationFingerprint(f.op), undefined,
    { canEnterExecutor: () => admitted, isAuthorized: () => true });
  expect(f.execute).toHaveBeenCalledOnce();
  admitted = false; f.finish();
  expect(await pending).toMatchObject({ status: 'succeeded', exitCode: 0 });
});
