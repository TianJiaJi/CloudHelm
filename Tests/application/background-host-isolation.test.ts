import { expect, it, vi } from 'vitest';
import { operationFingerprint, operationIntentKey, type ExecutionOptions, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import { HostSerialExecutor } from '../../packages/application/src/host-serial-executor.js';

const operation: ProposedOperation = { id: 'service', kind: 'command', command: 'python3 -m http.server 8080', executionMode: 'background',
  scope: { taskId: 'task', hostId: 'host', cwd: '/srv', runAs: 'user', terminalId: 'A', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'Run a temporary service and inspect it' } };
function fixture() {
  let finish!: (result: OperationResult) => void, start!: NonNullable<ExecutionOptions['onProcessStarted']>;
  const running = new Promise<OperationResult>((resolve) => { finish = resolve; });
  const downstream = { execute: vi.fn(async (op: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> => {
    if (op.id === operation.id) { start = options!.onProcessStarted!; return running; }
    return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: 'diagnostic' };
  }) };
  const serial = new HostSerialExecutor(downstream);
  return { serial, downstream, finish: (result: OperationResult) => finish(result), start: () => start({ pid: 42 }) };
}
const next = (id: string): ProposedOperation => ({ ...operation, id, scope: { ...operation.scope, taskId: 'another-task', terminalId: 'B' } });

it('binds background lifetime into approval but cannot evade replay identity by switching modes', () => {
  const foreground = { ...operation, executionMode: undefined };
  expect(operationFingerprint(operation)).not.toBe(operationFingerprint(foreground));
  expect(operationIntentKey(operation)).toBe(operationIntentKey(foreground));
});

it('admits independent read-only B after real start, not another write or risk acceptance, while A remains awaited', async () => {
  const f = fixture(), observed = vi.fn();
  const pending = f.serial.execute(operation, 'fingerprint', undefined, { onProcessStarted: observed });
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledTimes(1));
  const check = f.serial.execute(next('inspect'), 'other', undefined, { readOnly: true });
  expect(f.downstream.execute).toHaveBeenCalledTimes(1);
  f.start();
  expect(await check).toMatchObject({ status: 'succeeded', stdoutTail: 'diagnostic' });
  expect(observed).toHaveBeenCalledExactlyOnceWith({ pid: 42 });
  expect(f.serial.canReconcile('host', 'service')).toBe(false);
  expect(f.serial.reconcile('host', 'service')).toBe(false);
  expect(await f.serial.execute(next('mutate'), 'other')).toMatchObject({ status: 'failed', failureKind: 'unresolved-prior-operation' });
  expect(f.downstream.execute.mock.calls.map(([op]) => op.id)).toEqual(['service', 'inspect']);
  f.finish({ operationId: 'service', status: 'succeeded', exitCode: 0, stdoutTail: '' }); await pending;
  expect(await f.serial.execute(next('later'), 'other')).toMatchObject({ status: 'succeeded' });
});

it.each(['partial', 'unknown'] as const)('keeps %s effects blocked after background settlement', async (kind) => {
  const f = fixture(), pending = f.serial.execute(operation, 'fingerprint');
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledOnce()); f.start();
  f.finish({ operationId: 'service', status: kind === 'partial' ? 'failed' : 'unknown', effects: 'possible', stdoutTail: '' });
  await pending;
  expect(await f.serial.execute(next('mutate'), 'other')).toMatchObject({ failureKind: 'unresolved-prior-operation' });
  expect(f.serial.reconcile('host', 'service')).toBe(true);
});

it('preserves a live completion after tool interruption instead of releasing it as unknown', async () => {
  const f = fixture(), pending = f.serial.execute(operation, 'fingerprint');
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledOnce()); f.start();
  let complete!: (state: 'exited' | 'unknown') => void;
  const remoteCompletion = new Promise<'exited' | 'unknown'>((resolve) => { complete = resolve; });
  f.finish({ operationId: 'service', status: 'unknown', stdoutTail: '', remoteCompletion }); await pending;
  expect(f.serial.canReconcile('host', 'service')).toBe(false);
  complete('unknown'); await remoteCompletion;
  expect(await f.serial.execute(next('mutate'), 'other')).toMatchObject({ failureKind: 'unresolved-prior-operation' });
  expect(f.serial.canReconcile('host', 'service')).toBe(true);
});

it('does not release the background lock on raw exit before the full executor finishes', async () => {
  const f = fixture(), pending = f.serial.execute(operation, 'fingerprint');
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledOnce()); f.start();
  f.serial.observe('host', { operationId: 'service', status: 'succeeded', exitCode: 0, stdoutTail: '' });
  expect(f.serial.canReconcile('host', 'service')).toBe(false);
  expect(await f.serial.execute(next('too-early'), 'other')).toMatchObject({ failureKind: 'unresolved-prior-operation' });
  f.finish({ operationId: 'service', status: 'succeeded', exitCode: 0, stdoutTail: '' }); await pending;
  expect(await f.serial.execute(next('later'), 'other')).toMatchObject({ status: 'succeeded' });
});

it('retains partial failure observed during interruption even when its completion promise already says exited', async () => {
  const f = fixture(), pending = f.serial.execute(operation, 'fingerprint');
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledOnce()); f.start();
  f.serial.observe('host', { operationId: 'service', status: 'failed', exitCode: 130, effects: 'possible', stdoutTail: '' });
  expect(f.serial.canReconcile('host', 'service')).toBe(false);
  f.finish({ operationId: 'service', status: 'unknown', stdoutTail: '', remoteCompletion: Promise.resolve('exited') }); await pending;
  expect(await f.serial.execute(next('mutate'), 'other')).toMatchObject({ failureKind: 'unresolved-prior-operation' });
  expect(f.serial.canReconcile('host', 'service')).toBe(true);
});

it('does not release A on model-side startup failure without a transport observation', async () => {
  const f = fixture(), pending = f.serial.execute(operation, 'fingerprint');
  await vi.waitFor(() => expect(f.downstream.execute).toHaveBeenCalledOnce());
  const check = f.serial.execute(next('inspect'), 'other', undefined, { readOnly: true });
  expect(f.downstream.execute).toHaveBeenCalledTimes(1);
  f.finish({ operationId: 'service', status: 'failed', effects: 'none', stdoutTail: 'not dispatched' });
  await pending; await check; expect(f.downstream.execute).toHaveBeenCalledTimes(2);
});
