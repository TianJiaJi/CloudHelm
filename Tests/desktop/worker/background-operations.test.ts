import { expect, it, vi } from 'vitest';
import type { OperationResult, ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { applyOperationObservation } from '../../../apps/desktop/src/worker/operation-observation.js';
import { BackgroundOperations, createBackgroundOperations } from '../../../apps/desktop/src/worker/background-operations.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';
type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;
const op: ProposedOperation = { id: 'operation', kind: 'command', executionMode: 'background', command: 'sleep 10',
  scope: { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1, loginAs: 'login', runAs: 'root',
    cwd: '/srv', goal: 'Start an explicitly requested temporary service', policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [] } };
function feedback(result: OperationResult): Feedback {
  return { result, content: [{ type: 'text', text: 'observed result' }], details: undefined, isError: result.status !== 'succeeded' };
}
function fixture() {
  const persisted = vi.fn(), parent = new AbortController(), runtime = new BackgroundOperations('task', persisted);
  let finish!: (result: Feedback) => void, lifetime!: AbortSignal;
  const pending = new Promise<Feedback>((resolve) => { finish = resolve; });
  const tool = runtime.withLifetime(parent.signal, async (signal) => {
    lifetime = signal;
    return runtime.run(op, signal, async () => { runtime.proposed(op, 'connection:1'); return pending; });
  });
  return { runtime, persisted, parent, tool, signal: () => lifetime, finish };
}
it('returns startup separately while the audited execution stays alive beyond model cancellation', async () => {
  const f = fixture(); expect(f.runtime.hasLease('terminal')).toBe(false);
  f.runtime.started(op.id, { pid: 42 }); const result = await f.tool;
  expect(result.isError).toBe(false); expect(result.result).toBeUndefined();
  expect(result.details).toMatchObject({ executionJob: { status: 'running', exitObserved: false, pid: 42 } });
  f.parent.abort(); expect(f.signal().aborted).toBe(false); expect(f.runtime.hasLease('terminal')).toBe(true);
  f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
  await vi.waitFor(() => expect(f.runtime.hasLive).toBe(false));
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'exited', exitObserved: true, exitCode: 0 });
});

it('records the private log path and process identity observed with a native background start', async () => {
  const f = fixture();
  const logPath = '/tmp/.cloudhelm-bg-68bc578f-ad82-4194-8d50-ca55d477ed44.log';
  f.runtime.started(op.id, { pid: 42, logPath, processStartTime: 999 });
  const result = await f.tool;
  expect(result.details).toMatchObject({ executionJob: { pid: 42, logPath, processStartTime: 999, status: 'running' } });
  expect(f.runtime.snapshot()[0]).toMatchObject({ pid: 42, logPath, processStartTime: 999 });
  expect(() => f.runtime.started(op.id, { pid: 43, logPath: '/tmp/agent-chosen.log' })).toThrow('Invalid background log observation');
  f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
});

it('does not lend a background lease to another operation, identity, generation, or mode', async () => {
  const f = fixture(); f.runtime.started(op.id, { pid: 42 }); await f.tool;
  expect(f.runtime.hasOperationLease(op)).toBe(true);
  expect(f.runtime.hasOperationLease({ ...op, id: 'another' })).toBe(false);
  expect(f.runtime.hasOperationLease({ ...op, executionMode: undefined })).toBe(false);
  expect(f.runtime.hasOperationLease({ ...op, scope: { ...op.scope, terminalGeneration: 2 } })).toBe(false);
  expect(f.runtime.hasOperationLease({ ...op, scope: { ...op.scope, runAs: 'another' } })).toBe(false);
  f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
});

it('restores and publishes unknown state offline, without a live lease or resuming execution', async () => {
  const f = fixture(); f.runtime.started(op.id, { pid: 42 }); await f.tool;
  const prior: OperationView = { id: op.id, taskId: 'task', hostId: 'host', kind: 'command', preview: op.command,
    status: 'running', createdAt: 1, executionJob: f.runtime.snapshot()[0] };
  const publish = vi.fn(), operations = new Map<string, OperationView>();
  const restored = createBackgroundOperations('task', [prior], operations, publish, vi.fn());
  expect(restored.snapshot()[0]).toMatchObject({ status: 'unknown', unknownReason: 'recovered' });
  expect(operations.get(op.id)?.status).toBe('unknown'); expect(publish).toHaveBeenCalledOnce();
  expect(restored.hasLive).toBe(false); expect(restored.hasOperationLease(op)).toBe(false);
  f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
});

it('preserves persisted exit evidence if interruption arrives after the process completed', async () => {
  const f = fixture(); f.runtime.started(op.id, { pid: 42 }); await f.tool;
  const prior: OperationView = { id: op.id, taskId: 'task', hostId: 'host', kind: 'command', preview: op.command,
    status: 'succeeded', exitCode: 0, exitObserved: true, completedAt: 50, createdAt: 1, executionJob: f.runtime.snapshot()[0] };
  const operations = new Map<string, OperationView>();
  const restored = createBackgroundOperations('task', [prior], operations, vi.fn(), vi.fn());
  expect(restored.snapshot()[0]).toMatchObject({ status: 'exited', exitObserved: true, exitCode: 0 });
  const actual = operations.get(op.id)!;
  applyOperationObservation(actual, { operationId: op.id, status: 'unknown', stdoutTail: 'aborted await' });
  expect(actual).toMatchObject({ status: 'succeeded', exitCode: 0, exitObserved: true, completedAt: 50 });
  f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
});

it('links cancellation until actual startup and cannot detach from an aborted launch', async () => {
  const f = fixture(); f.parent.abort();
  expect(f.signal().aborted).toBe(true);
  expect(() => f.runtime.started(op.id, { pid: 42 })).toThrow('recipient');
  f.finish(feedback({ operationId: op.id, status: 'unknown', stdoutTail: '' }));
  expect((await f.tool).isError).toBe(true); expect(f.runtime.hasLease('terminal')).toBe(false);
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'unknown', exitObserved: false });
});

it('keeps a live remote observation after interruption and applies the eventual actual exit', async () => {
  const f = fixture(); f.runtime.started(op.id, { pid: 42 }); await f.tool;
  let done!: (state: 'exited' | 'unknown') => void;
  const remoteCompletion = new Promise<'exited' | 'unknown'>((resolve) => { done = resolve; });
  f.finish(feedback({ operationId: op.id, status: 'unknown', stdoutTail: '', remoteCompletion }));
  await vi.waitFor(() => expect(f.runtime.snapshot()[0]?.status).toBe('unknown'));
  expect(f.runtime.hasLive).toBe(true);
  f.runtime.observe({ operationId: op.id, status: 'failed', exitCode: 130, effects: 'possible', stdoutTail: '' });
  done('exited'); await vi.waitFor(() => expect(f.runtime.hasLive).toBe(false));
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'failed', exitObserved: true, exitCode: 130 });
});

it('does not invent process start when the full operation ends before the first notification', async () => {
  const f = fixture(); f.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: 'fast' }));
  expect((await f.tool).result?.exitCode).toBe(0);
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'exited', processSequence: 0, exitObserved: true });
  expect(() => f.runtime.started(op.id, { pid: 42 })).toThrow('recipient');
});

it('records review rejection without a process exit and cannot reuse a detached lifetime for another action', async () => {
  const f = fixture(); f.finish({ content: [{ type: 'text', text: 'denied' }], details: undefined, isError: true });
  expect((await f.tool).isError).toBe(true);
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'failed', notStarted: 'denied', exitObserved: false });
  const active = fixture(); active.runtime.started(op.id, { pid: 42 }); await active.tool;
  const dispatch = vi.fn();
  await expect(active.runtime.run({ ...op, id: 'next' }, active.signal(), dispatch)).rejects.toThrow('unavailable');
  expect(dispatch).not.toHaveBeenCalled();
  active.finish(feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }));
});

it('closing observation never claims remote exit or leaks a transport exception to the model', async () => {
  const f = fixture(); f.runtime.started(op.id, { pid: 42 }); await f.tool;
  f.runtime.close(); expect(f.signal().aborted).toBe(true);
  expect(f.runtime.snapshot()[0]).toMatchObject({ status: 'unknown', exitObserved: false });
  await expect(f.runtime.withLifetime(undefined, vi.fn())).rejects.toThrow('closed');
  f.finish(feedback({ operationId: op.id, status: 'unknown', stdoutTail: '' }));
  const runtime = new BackgroundOperations('task', vi.fn());
  const reply = await runtime.withLifetime(undefined, (signal) => runtime.run(op, signal, async () => {
    runtime.proposed(op, 'connection:1'); throw new Error('private-transport-detail');
  }));
  expect(reply.isError).toBe(true); expect(JSON.stringify(reply)).not.toContain('private-transport-detail');
});

it('does not dispatch when the starting snapshot cannot be persisted', async () => {
  const runtime = new BackgroundOperations('task', () => { throw new Error('disk failed'); }), dispatch = vi.fn();
  const reply = await runtime.withLifetime(undefined, (signal) => runtime.run(op, signal, async () => {
    runtime.proposed(op, 'connection:1'); dispatch(); return feedback({ operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' });
  }));
  expect(reply.isError).toBe(true); expect(dispatch).not.toHaveBeenCalled(); expect(runtime.hasLive).toBe(false);
});
