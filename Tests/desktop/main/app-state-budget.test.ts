import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { TaskView } from '@cloudhelm/contracts';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(legacy?: TaskView) {
  const store = new SqliteStore(':memory:'); if (legacy) store.put('tasks', legacy.id, legacy);
  const state = new AppState(store, () => {});
  cleanups.push(() => { state.close(); store.close(); });
  return { state, store, task: legacy ?? state.createTask('Explain SSH', [], 'fixture', []) };
}
it('uses explicit new-task budgets and rejects worker-supplied cumulative counters', () => {
  const { state, store, task } = setup();
  expect(task.budget).toMatchObject({ origin: 'explicit', roundUsed: 0, roundLimit: 100 });
  state.record({ type: 'task-status', taskId: task.id, status: 'running', requestCount: 999 });
  expect(state.getTask(task.id).requestCount).toBe(0);
  const result = state.requestBudget({ kind: 'reserve', taskId: task.id, roundId: task.budget!.roundId,
    attempt: { logicalRequestId: 'one', purpose: 'conversation', attempt: 1, transport: 'http' } });
  expect(result).toMatchObject({ value: { kind: 'reserve', budget: { roundUsed: 1, totalUsed: 1 } } });
  state.record({ type: 'task-status', taskId: task.id, status: 'running', requestCount: 0 });
  expect(store.get<TaskView>('tasks', task.id)?.requestCount).toBe(1);
});
it('retains factual closure across restoration and starts one fresh round at genuine input', () => {
  const { state, task } = setup();
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  const closed = state.requestBudgets.complete(task.id);
  expect(closed.closed).toBe(true);
  state.record({ type: 'task-status', taskId: task.id, status: 'paused' });
  const next = state.requestBudgets.input(task.id, 'real-input');
  expect(next.budget.roundId).not.toBe(closed.roundId);
  expect(state.requestBudgets.input(task.id, 'real-input')).toMatchObject({ duplicate: true, budget: next.budget });
});
it('closes a completed honest unverified report without clearing its failed checks or granting success', () => {
  const { state, task } = setup();
  state.record({ type: 'work-report', taskId: task.id, report: { version: 2, summary: '检查条件不足，未声称成功', access: ['不适用'],
    changes: ['已登记变更'], recovery: ['保留备份'], evidenceOperationIds: [], checks: [],
    unverifiedChanges: [{ operationId: 'write', reason: '外部检查未获授权' }] } });
  state.record({ type: 'verification-state', taskId: task.id, value: { status: 'unverified', reasonCode: 'changes-unverified', operationIds: ['write'] } });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  expect(state.requestBudgets.complete(task.id).closed).toBe(true);
  expect(state.getTask(task.id).verificationState?.status).toBe('unverified');
  expect(state.getTask(task.id).report?.unverifiedChanges).toHaveLength(1);
});
it('conservatively initializes legacy exhaustion without upgrading a paused task to a new allowance', () => {
  const old: TaskView = { id: 'legacy', goal: 'Old work', hostIds: [], localScopes: [], modelId: 'fixture',
    status: 'paused', requestCount: 900, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const { state } = setup(old);
  const first = state.requestBudgets.current(old.id);
  expect(first).toMatchObject({ origin: 'legacy', roundUsed: 100, totalUsed: 900, roundLimit: 100 });
  const continued = state.requestBudgets.input(old.id, 'continue');
  expect(continued.budget).toEqual(first);
});
it('authorizes idle compaction only for a live task-bound preparation and retains its charge after cancellation', () => {
  const { state, store, task } = setup();
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  state.record({ type: 'task-status', taskId: task.id, status: 'answered' });
  const budget = state.requestBudgets.input(task.id, 'preparation').budget;
  const command = { kind: 'reserve', taskId: task.id, roundId: budget.roundId, preparationId: 'preparation',
    attempt: { logicalRequestId: 'idle-summary', purpose: 'compaction', attempt: 1, transport: 'http' } };
  store.put('message-receipts', 'preparation', { state: 'preparing', conversationId: task.id });
  expect(state.requestBudget(command)).toEqual({ error: 'budget-unavailable' });
  state.setBudgetPreparationAuthority((id, taskId) => id === 'preparation' && taskId === task.id);
  store.put('message-receipts', 'preparation', { state: 'preparing', conversationId: 'foreign' });
  expect(state.requestBudget(command)).toEqual({ error: 'budget-unavailable' });
  store.put('message-receipts', 'preparation', { state: 'preparing', conversationId: task.id });
  expect(state.requestBudget({ ...command, attempt: { ...command.attempt, purpose: 'conversation' } })).toEqual({ error: 'budget-unavailable' });
  state.record({ type: 'execution', taskId: task.id, value: { model: 'running', remote: 'unknown', stopping: false, canStop: true } });
  expect(state.requestBudget(command)).toEqual({ error: 'budget-unavailable' });
  state.record({ type: 'execution', taskId: task.id, value: { model: 'running', remote: 'idle', stopping: false, canStop: true } });
  expect(state.requestBudget(command)).toMatchObject({ value: { preparationId: 'preparation', budget: { roundUsed: 1 } } });
  expect(state.getTask(task.id).status).toBe('answered');
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  expect(state.requestBudgets.complete(task.id).closed).toBe(false);
  state.setBudgetPreparationAuthority(() => false);
  expect(state.requestBudget(command)).toEqual({ error: 'budget-unavailable' });
  expect(state.requestBudgets.current(task.id).roundUsed).toBe(1);
  expect(state.requestBudgets.input(task.id, 'replacement').budget).toMatchObject({ roundId: budget.roundId, roundUsed: 1 });
});
it('does not let a preparing receipt invent the genuine input boundary', () => {
  const { state, store, task } = setup();
  state.record({ type: 'task-status', taskId: task.id, status: 'paused' });
  state.record({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'idle', stopping: false, canStop: false } });
  state.setBudgetPreparationAuthority(() => true);
  store.put('message-receipts', 'forged', { state: 'preparing', conversationId: task.id });
  expect(state.requestBudget({ kind: 'reserve', taskId: task.id, roundId: task.budget!.roundId, preparationId: 'forged',
    attempt: { logicalRequestId: 'forged-attempt', purpose: 'compaction', attempt: 1, transport: 'http' } })).toEqual({ error: 'budget-stale' });
  expect(state.requestBudgets.current(task.id).totalUsed).toBe(0);
});
it('requires both a live preparation and its durable preparing receipt for auxiliary requests', () => {
  const { state, store } = setup();
  const command = { kind: 'summary', requestId: 'preparation',
    attempt: { logicalRequestId: 'summary-one', purpose: 'summary', attempt: 1, transport: 'http' } };
  store.put('message-receipts', 'preparation', { state: 'preparing' });
  expect(state.requestBudget(command)).toEqual({ error: 'budget-unavailable' });
  state.setBudgetPreparationAuthority((id) => id === 'preparation');
  expect(state.requestBudget(command)).toMatchObject({ value: { kind: 'summary', used: 1, limit: 32 } });
  store.put('message-receipts', 'preparation', { state: 'sent' });
  expect(state.requestBudget({ ...command, attempt: { ...command.attempt, logicalRequestId: 'summary-two' } }))
    .toEqual({ error: 'budget-unavailable' });
});
