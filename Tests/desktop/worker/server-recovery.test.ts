import { expect, it, vi } from 'vitest';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';
import type { OperationView } from '@cloudhelm/contracts';

const accepted: OperationView = { id: 'old', taskId: 'source', hostId: 'host', kind: 'command', preview: 'old write',
  status: 'unknown', createdAt: 1, reconciledAt: 42,
  reconciliation: { kind: 'risk-accepted', explanation: '人工检查并承担未知结果风险', at: 42, sourceTaskId: 'recovery' } };

function setup() {
  const server = new WorkerServer(() => undefined);
  const executor = { canReconcile: vi.fn(() => true), reconcile: vi.fn(() => true) };
  const runner = { assertResolvableOutcome: vi.fn(), recordRiskAcceptance: vi.fn() };
  const internals = server as unknown as { executor: typeof executor; tasks: Map<string, typeof runner> };
  internals.executor = executor;
  internals.tasks.set('source', runner);
  return { server, executor, runner };
}

it('prepares without releasing any host write lock and rejects a live remote completion', async () => {
  const { server, executor, runner } = setup();
  executor.canReconcile.mockReturnValue(false);
  await expect(server.dispatch({ method: 'prepare-operation-risk', operationId: 'old', hostId: 'host' }))
    .rejects.toThrow('仍在运行');
  expect(runner.assertResolvableOutcome).toHaveBeenCalledWith('old');
  expect(executor.reconcile).not.toHaveBeenCalled();
});

it('does not turn a released write lock into an ambiguous failure if status publishing fails', async () => {
  const { server, executor, runner } = setup();
  runner.recordRiskAcceptance.mockImplementation(() => { throw new Error('event disconnected'); });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(server.dispatch({ method: 'commit-operation-risk', operation: accepted })).resolves.toBeUndefined();
    expect(executor.reconcile).toHaveBeenCalledWith('host', 'old');
    expect(runner.recordRiskAcceptance).toHaveBeenCalledExactlyOnceWith(accepted);
  } finally { warning.mockRestore(); }
});

it('rejects an invalid commit snapshot before releasing any lock', async () => {
  const { server, executor, runner } = setup();
  await expect(server.dispatch({ method: 'commit-operation-risk', operation: { ...accepted, status: 'running' } }))
    .rejects.toThrow('无效');
  expect(executor.reconcile).not.toHaveBeenCalled();
  expect(runner.recordRiskAcceptance).not.toHaveBeenCalled();
});

it('does not publish an acceptance if the tracked remote process is still live', async () => {
  const { server, executor, runner } = setup();
  executor.reconcile.mockReturnValue(false);
  await expect(server.dispatch({ method: 'commit-operation-risk', operation: accepted })).rejects.toThrow('尚未退出');
  expect(runner.recordRiskAcceptance).not.toHaveBeenCalled();
});
