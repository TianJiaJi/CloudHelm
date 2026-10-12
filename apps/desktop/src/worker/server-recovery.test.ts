import { expect, it, vi } from 'vitest';
import { WorkerServer } from './server.js';

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
    await expect(server.dispatch({ method: 'commit-operation-risk', operationId: 'old', hostId: 'host',
      explanation: '人工检查并承担未知结果风险', at: 42 })).resolves.toBeUndefined();
    expect(executor.reconcile).toHaveBeenCalledWith('host', 'old');
    expect(runner.recordRiskAcceptance).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});

it('does not publish an acceptance if the tracked remote process is still live', async () => {
  const { server, executor, runner } = setup();
  executor.reconcile.mockReturnValue(false);
  await expect(server.dispatch({ method: 'commit-operation-risk', operationId: 'old', hostId: 'host',
    explanation: '人工检查并承担未知结果风险', at: 42 })).rejects.toThrow('尚未退出');
  expect(runner.recordRiskAcceptance).not.toHaveBeenCalled();
});
