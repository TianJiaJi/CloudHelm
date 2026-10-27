import { afterEach, expect, it, vi } from 'vitest';
import { createRequestBudget, reserveRoundRequest } from '@cloudhelm/core';
import type { BudgetCommand, BudgetRequestMessage } from '@cloudhelm/contracts';
import { RequestBudgetClient } from './request-budget-client.js';

afterEach(() => vi.useRealTimers());
const command: Extract<BudgetCommand, { kind: 'reserve' }> = { kind: 'reserve', taskId: 'task', roundId: 'round',
  attempt: { logicalRequestId: 'logical', purpose: 'conversation', transport: 'http', attempt: 1 } };
function setup() {
  const sent: BudgetRequestMessage[] = [];
  const post = vi.fn((message: BudgetRequestMessage) => { sent.push(message); });
  const confirmed = vi.fn(); const client = new RequestBudgetClient(post, 100, confirmed);
  const reply = () => ({ id: sent[0]!.budgetRequest.id, value: { kind: 'reserve' as const, taskId: 'task',
    budget: reserveRoundRequest(createRequestBudget('round')), duplicate: false } });
  return { client, post, sent, reply, confirmed };
}
it('does not permit dispatch before confirmation and resolves only once for a matching receipt', async () => {
  vi.useFakeTimers(); const f = setup(); const dispatch = vi.fn();
  const pending = f.client.request(command).then(dispatch);
  await Promise.resolve(); expect(dispatch).not.toHaveBeenCalled();
  f.client.resolve(f.reply()); f.client.resolve(f.reply());
  await pending; expect(dispatch).toHaveBeenCalledOnce(); expect(f.confirmed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0); f.client.close();
});
it('does not mutate a caller command or accept a foreign task/round acknowledgment', async () => {
  const f = setup(); const mutable = structuredClone(command);
  const pending = f.client.request(mutable);
  mutable.taskId = 'different';
  expect(f.sent[0]!.budgetRequest.command).toEqual(command);
  f.client.resolve({ ...f.reply(), value: { ...f.reply().value, taskId: 'foreign' } });
  await expect(pending).rejects.toThrow('budget-stale');
  const second = f.client.request(command);
  f.client.resolve({ id: f.sent[1]!.budgetRequest.id, value: { ...f.reply().value,
    budget: { ...f.reply().value.budget, roundId: 'other' } } });
  await expect(second).rejects.toThrow('budget-stale'); f.client.close();
});
it('keeps optional diagnostic callbacks isolated from confirmation/dispatch authority', async () => {
  const f = setup(); f.confirmed.mockImplementationOnce(() => { throw new Error('diagnostic sink failed'); });
  const pending = f.client.request(command); f.client.resolve(f.reply());
  await expect(pending).resolves.toMatchObject({ kind: 'reserve', budget: { totalUsed: 1 } });
  expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(command, f.reply().value); f.client.close();
});
it('requires exact preparation identity in the acknowledgment, not just task and round', async () => {
  const f = setup();
  const prepared = { ...command, preparationId: 'preparation', attempt: { ...command.attempt, purpose: 'compaction' as const } };
  const first = f.client.request(prepared);
  f.client.resolve(f.reply()); await expect(first).rejects.toThrow('budget-stale');
  const second = f.client.request(prepared);
  f.client.resolve({ id: f.sent[1]!.budgetRequest.id, value: { ...f.reply().value, preparationId: 'foreign' } });
  await expect(second).rejects.toThrow('budget-stale');
  const third = f.client.request(prepared);
  f.client.resolve({ id: f.sent[2]!.budgetRequest.id, value: { ...f.reply().value, preparationId: 'preparation' } });
  await expect(third).resolves.toMatchObject({ preparationId: 'preparation' }); f.client.close();
});
it('cancels a pending waiter without sending a refund, and discards late success', async () => {
  vi.useFakeTimers(); const f = setup(); const controller = new AbortController(); const dispatch = vi.fn();
  const pending = f.client.request(command, controller.signal).then(dispatch);
  const rejected = expect(pending).rejects.toThrow('取消');
  controller.abort(); await rejected;
  f.client.resolve(f.reply()); expect(dispatch).not.toHaveBeenCalled(); expect(f.confirmed).not.toHaveBeenCalled();
  expect(f.post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  await expect(f.client.request(command, controller.signal)).rejects.toThrow('取消');
  expect(f.post).toHaveBeenCalledOnce(); f.client.close();
});
it('times out without granting or replaying an attempt and rejects requests after shutdown', async () => {
  vi.useFakeTimers(); const f = setup();
  const pending = f.client.request(command); const rejected = expect(pending).rejects.toThrow('预算确认不可用');
  await vi.advanceTimersByTimeAsync(100); await rejected;
  f.client.resolve(f.reply()); expect(f.post).toHaveBeenCalledOnce();
  const next = f.client.request(command); const closed = expect(next).rejects.toThrow('预算确认不可用');
  f.client.close(); await closed;
  await expect(f.client.request(command)).rejects.toThrow('预算确认不可用');
  expect(vi.getTimerCount()).toBe(0);
});
it('suppresses transport details and rejects malformed or uncharged confirmations', async () => {
  vi.useFakeTimers(); const f = setup();
  f.post.mockImplementationOnce(() => { throw new Error('private path and token'); });
  await expect(f.client.request(command)).rejects.toThrow('预算确认不可用');
  expect(vi.getTimerCount()).toBe(0);
  const pending = f.client.request(command);
  f.client.resolve({ id: f.sent[0]!.budgetRequest.id, error: 'private token in error' });
  await expect(pending).rejects.toThrow('budget-invalid');
  const next = f.client.request(command);
  f.client.resolve({ id: f.sent[1]!.budgetRequest.id, value: { ...f.reply().value, budget: createRequestBudget('round') } });
  await expect(next).rejects.toThrow('budget-stale');
  expect(vi.getTimerCount()).toBe(0); f.client.close();
});
it('preserves typed exhaustion and validates auxiliary scope bindings', async () => {
  const f = setup();
  const pending = f.client.request(command);
  f.client.resolve({ id: f.sent[0]!.budgetRequest.id, error: 'budget-exhausted' });
  await expect(pending).rejects.toMatchObject({ code: 'budget-exhausted' });
  const summary = f.client.request({ kind: 'summary', requestId: 'document', attempt: { ...command.attempt, purpose: 'summary' } });
  f.client.resolve({ id: f.sent[1]!.budgetRequest.id, value: { kind: 'summary', scopeId: 'foreign', used: 1, limit: 32 } });
  await expect(summary).rejects.toThrow('budget-stale');
  const review = f.client.request({ kind: 'review', taskId: 'task', operationId: 'operation', attempt: { ...command.attempt, purpose: 'review' } });
  f.client.resolve({ id: f.sent[2]!.budgetRequest.id, value: { kind: 'review', scopeId: 'operation', used: 1, limit: 3 } });
  await expect(review).resolves.toMatchObject({ kind: 'review', used: 1 }); f.client.close();
});
it('rejects secret-bearing or unsupported opaque attempts before transport', async () => {
  const f = setup();
  const injected = { ...command, apiKey: 'fixture-private' };
  await expect(f.client.request(injected)).rejects.toThrow('budget-invalid');
  await expect(f.client.request({ ...command, attempt: { ...command.attempt, transport: 'opaque', attempt: 2 } })).rejects.toThrow('budget-invalid');
  expect(f.post).not.toHaveBeenCalled(); f.client.close();
});
