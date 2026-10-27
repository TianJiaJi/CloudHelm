import { describe, expect, it, vi } from 'vitest';
import { createRequestBudget, reserveRoundRequest, type ModelRequestAttempt } from '@cloudhelm/core';
import { TaskRequestBudget, type BudgetPort } from './task-request-budget.js';

const attempt: ModelRequestAttempt = { logicalRequestId: 'request-one', purpose: 'conversation', attempt: 1, transport: 'http' };
describe('task request budget boundary', () => {
  it('never creates an in-memory allowance if Main is absent', async () => {
    await expect(new TaskRequestBudget('task').reserve(attempt)).rejects.toThrow('预算确认不可用');
  });
  it('uses a fresh authoritative round and returns cumulative reservations, not the old task limit', async () => {
    const initial = { ...createRequestBudget('new-round', 1), totalUsed: 100 };
    const request = vi.fn<BudgetPort>(async (command) => command.kind === 'current'
      ? { kind: 'current', taskId: 'task', budget: initial }
      : { kind: 'reserve', taskId: 'task', budget: reserveRoundRequest(initial), duplicate: false });
    const result = await new TaskRequestBudget('task', request).reserve(attempt);
    expect(result).toMatchObject({ roundUsed: 1, totalUsed: 101 });
    expect(request.mock.calls[1]?.[0]).toEqual({ kind: 'reserve', taskId: 'task', roundId: 'new-round', attempt });
  });
  it('refuses a foreign or uncharged confirmation', async () => {
    const state = createRequestBudget('round');
    const budget = new TaskRequestBudget('task', async (command) => command.kind === 'current'
      ? { kind: 'current', taskId: 'task', budget: state }
      : { kind: 'reserve', taskId: 'task', budget: state, duplicate: false });
    await expect(budget.reserve(attempt)).rejects.toThrow('budget-stale');
    await expect(new TaskRequestBudget('task', async () => ({ kind: 'current', taskId: 'foreign', budget: state })).current())
      .rejects.toThrow('budget-stale');
  });
  it('binds an idle compaction reservation to preparation identity without allowing conversation sends', async () => {
    const state = createRequestBudget('round'); let echo = 'preparation';
    const request = vi.fn<BudgetPort>(async (command) => command.kind === 'current'
      ? { kind: 'current', taskId: 'task', budget: state }
      : { kind: 'reserve', taskId: 'task', budget: reserveRoundRequest(state), duplicate: false, preparationId: echo });
    const budget = new TaskRequestBudget('task', request);
    await expect(budget.reserve(attempt, undefined, 'preparation')).rejects.toThrow('budget-invalid');
    expect(request).not.toHaveBeenCalled();
    const compact = { ...attempt, purpose: 'compaction' as const };
    await expect(budget.reserve(compact, undefined, 'preparation')).resolves.toMatchObject({ totalUsed: 1 });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ kind: 'reserve', preparationId: 'preparation', roundId: 'round' });
    echo = 'foreign'; await expect(budget.reserve(compact, undefined, 'preparation')).rejects.toThrow('budget-stale');
  });
  it('checks availability before a resume can reacquire remote terminals', async () => {
    const state = reserveRoundRequest(createRequestBudget('round', 1));
    const budget = new TaskRequestBudget('task', async () => ({ kind: 'current', taskId: 'task', budget: state }));
    await expect(budget.assertAvailable()).rejects.toThrow('budget-exhausted');
    state.closed = true;
    await expect(budget.assertAvailable()).rejects.toThrow('budget-round-closed');
  });
  it('retains the charge but rejects dispatch if cancellation wins after acknowledgment', async () => {
    const controller = new AbortController(); let state = createRequestBudget('round');
    const budget = new TaskRequestBudget('task', async (command) => {
      if (command.kind === 'current') return { kind: 'current', taskId: 'task', budget: state };
      state = reserveRoundRequest(state); controller.abort();
      return { kind: 'reserve', taskId: 'task', budget: state, duplicate: false };
    });
    await expect(budget.reserve(attempt, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.totalUsed).toBe(1);
  });
});
