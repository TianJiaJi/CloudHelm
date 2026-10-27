import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { TaskView } from '@cloudhelm/contracts';
import { RequestBudgetAuthority } from './request-budget-authority.js';
import { extendRequestBudget } from './extend-request-budget.js';

const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  let task: TaskView = { id: 'task', goal: 'fixture', hostIds: [], localScopes: [], modelId: 'fixture',
    status: 'paused', resumeReason: 'budget-exhausted', requestCount: 1, requestLimit: 1, createdAt: 1, updatedAt: 1 };
  store.put('tasks', task.id, task);
  let remoteIdle = true;
  const authority = new RequestBudgetAuthority(store, { task: () => task, replace: (next) => { task = next; },
    completion: () => ({ answered: false, unresolved: !remoteIdle, reportPending: false, modelIdle: true, remoteIdle }) });
  const budget = authority.current(task.id);
  const input = { taskId: task.id, roundId: budget.roundId, budgetRevision: budget.budgetRevision, requestId: 'extension' };
  const deps = { authority, live: () => ({ task, modelIdle: true, remoteIdle }),
    restore: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  return { input, deps, task: () => task, update: (fields: Partial<TaskView>) => {
    task = { ...task, ...fields }; store.put('tasks', task.id, task);
  }, remote: (idle: boolean) => { remoteIdle = idle; } };
}
it('adds exactly 100 and dispatches once for concurrent and subsequent duplicate clicks', async () => {
  const f = setup();
  await Promise.all([extendRequestBudget(f.input, f.deps), extendRequestBudget(f.input, f.deps)]);
  expect(f.task().budget).toMatchObject({ roundLimit: 101, totalUsed: 1, defaultRoundLimit: 1 });
  expect(f.deps.resume).toHaveBeenCalledOnce();
  expect(await extendRequestBudget(f.input, f.deps)).toMatchObject({ continuation: 'acknowledged' });
  expect(f.deps.resume).toHaveBeenCalledOnce();
});
it('retains a dispatching claim after a lost reply and never automatically dispatches again', async () => {
  const f = setup(); f.deps.resume.mockRejectedValueOnce(new Error('lost acknowledgment'));
  await expect(extendRequestBudget(f.input, f.deps)).rejects.toThrow('lost acknowledgment');
  expect(await extendRequestBudget(f.input, f.deps)).toMatchObject({ continuation: 'uncertain', grant: { phase: 'dispatching' } });
  expect(f.deps.resume).toHaveBeenCalledOnce();
  expect(f.task().budget?.roundLimit).toBe(101);
});
it.each(['verify', 'interrupted', 'report'] as const)('does not replace the %s stop or automatically resume it', async (reason) => {
  const f = setup(); f.update({ resumeReason: reason });
  expect(await extendRequestBudget(f.input, f.deps)).toMatchObject({ continuation: 'blocked', grant: { phase: 'granted' } });
  expect(f.task().resumeReason).toBe(reason);
  expect(f.deps.restore).not.toHaveBeenCalled(); expect(f.deps.resume).not.toHaveBeenCalled();
});
it('rechecks safety after asynchronous restoration without refunding or dispatching', async () => {
  const f = setup(); f.deps.restore.mockImplementation(async () => { f.update({ resumeReason: 'interrupted' }); });
  expect(await extendRequestBudget(f.input, f.deps)).toMatchObject({ continuation: 'blocked' });
  expect(f.deps.resume).not.toHaveBeenCalled(); expect(f.task().budget?.roundLimit).toBe(101);
});
it('does not continue while a remote process is still active or uncertain', async () => {
  const f = setup(); f.remote(false);
  expect(await extendRequestBudget(f.input, f.deps)).toMatchObject({ continuation: 'blocked' });
  expect(f.deps.resume).not.toHaveBeenCalled();
});
it('rejects caller-selected amounts and stale bindings without dispatch', async () => {
  const f = setup();
  await expect(extendRequestBudget({ ...f.input, amount: 999 }, f.deps)).rejects.toThrow('budget-invalid');
  await expect(extendRequestBudget({ ...f.input, roundId: 'foreign' }, f.deps)).rejects.toThrow('budget-stale');
  expect(f.task().budget?.roundLimit).toBe(1); expect(f.deps.resume).not.toHaveBeenCalled();
});
