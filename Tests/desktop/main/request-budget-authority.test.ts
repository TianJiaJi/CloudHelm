import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { ModelRequestAttempt, RoundCompletion } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import { RequestBudgetAuthority } from '../../../apps/desktop/src/main/request-budget-authority.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(count = 0, limit = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'cloudhelm-budget-')); const file = join(dir, 'state.db');
  const store = new SqliteStore(file);
  let task: TaskView = { id: 'task', goal: 'fixture', hostIds: [], localScopes: [], modelId: 'fixture',
    requestCount: count, requestLimit: limit, status: 'running', createdAt: 1, updatedAt: 1 };
  store.put('tasks', task.id, task);
  let facts: RoundCompletion = { answered: false, unresolved: false, reportPending: false, modelIdle: false, remoteIdle: true };
  let loseAck = false;
  const authority = new RequestBudgetAuthority(store, {
    task: (id) => { if (id !== task.id) throw new Error('Unknown task'); return task; },
    replace: (value) => { task = value; if (loseAck) throw new Error('acknowledgment lost'); },
    completion: () => facts
  });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file, authority, task: () => task,
    lostAck: (value: boolean) => { loseAck = value; },
    update: (value: Partial<TaskView>, completion: Partial<RoundCompletion> = {}) => {
      task = { ...task, ...value }; facts = { ...facts, ...completion }; store.put('tasks', task.id, task);
    },
    reload: () => { task = store.get<TaskView>('tasks', 'task')!; }
  };
}
function request(logicalRequestId: string, purpose: ModelRequestAttempt['purpose'] = 'conversation', attempt = 1): ModelRequestAttempt {
  return { logicalRequestId, purpose, attempt, transport: 'http' };
}
it('does not close or refill a new input round using the previous answer, including after reload', () => {
  const f = fixture(); f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  const first = f.authority.input('task', 'first-input').budget;
  expect(f.authority.complete('task').closed).toBe(false);
  f.reload();
  const second = f.authority.input('task', 'replacement-input').budget;
  expect(second.roundId).toBe(first.roundId);
  f.update({ status: 'running' }, { answered: false, modelIdle: false });
  f.authority.reserve('task', first.roundId, request('preparation', 'compaction'));
  f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  expect(f.authority.complete('task').closed).toBe(false);
  expect(f.authority.input('task', 'after-cancel').budget).toMatchObject({ roundId: first.roundId, roundUsed: 1 });
  f.update({ status: 'running' }, { answered: false, modelIdle: false });
  f.authority.reserve('task', first.roundId, request('genuine-conversation'));
  f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  expect(f.authority.complete('task').closed).toBe(true);
});
it('atomically rolls back the fresh round, input marker and receipt on marker write failure', () => {
  const f = fixture(); f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  const before = f.authority.current('task'); const put = f.store.put.bind(f.store);
  const spy = vi.spyOn(f.store, 'put').mockImplementation((bucket, id, value) => {
    put(bucket, id, value);
    if (bucket === 'request-round-inputs') throw new Error('marker storage failure');
  });
  expect(() => f.authority.input('task', 'fresh')).toThrow('marker storage failure');
  expect(f.store.get<TaskView>('tasks', 'task')?.budget).toEqual(before);
  expect(f.task().budget).toEqual(before);
  expect(f.store.get('request-round-inputs', 'task')).toBeUndefined();
  expect(f.store.requestBudgetReceipt('task:task', 'input:fresh')).toBeUndefined();
  spy.mockRestore();
  expect(f.authority.input('task', 'fresh').duplicate).toBe(false);
  expect(f.authority.complete('task').closed).toBe(false);
});
it('charges manual compaction retries to one input-bound round without promoting task state or crossing preparations', () => {
  const f = fixture(); f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  const round = f.authority.input('task', 'prepare-one').budget.roundId;
  expect(() => f.authority.reserve('task', round, request('compact', 'compaction'))).toThrow('not active');
  expect(f.authority.reserve('task', round, request('compact', 'compaction'), 'prepare-one').budget.roundUsed).toBe(1);
  expect(f.task().status).toBe('answered');
  f.authority.input('task', 'prepare-two');
  expect(() => f.authority.reserve('task', round, request('compact', 'compaction', 2), 'prepare-two')).toThrow('budget-stale');
  expect(() => f.authority.reserve('task', round, request('conversation'), 'prepare-one')).toThrow('budget-invalid');
  expect(f.authority.reserve('task', round, request('compact', 'compaction', 2), 'prepare-one').budget.roundUsed).toBe(2);
  expect(f.authority.reserve('task', round, request('compact', 'compaction'), 'prepare-one').duplicate).toBe(true);
  expect(f.authority.complete('task').closed).toBe(false);
});
it('fails closed on malformed persisted input-round markers', () => {
  const f = fixture(); f.authority.input('task', 'input');
  f.store.put('request-round-inputs', 'task', null);
  expect(() => f.authority.complete('task')).toThrow('budget-stale');
  expect(() => f.authority.input('task', 'next')).toThrow('budget-stale');
});
it('durably charges each attempt before acknowledgment and idempotently returns duplicate reservations', () => {
  const f = fixture(0, 3); const initial = f.authority.current('task');
  const first = f.authority.reserve('task', initial.roundId, request('logical'));
  expect(first).toMatchObject({ duplicate: false, budget: { roundUsed: 1, totalUsed: 1 } });
  expect(f.store.get<TaskView>('tasks', 'task')?.budget).toEqual(first.budget);
  const retry = f.authority.reserve('task', initial.roundId, request('logical', 'conversation', 2));
  expect(retry.budget.roundUsed).toBe(2);
  const duplicate = f.authority.reserve('task', initial.roundId, request('logical'));
  expect(duplicate).toMatchObject({ duplicate: true, budget: { roundUsed: 2, totalUsed: 2 } });
  expect(() => f.authority.reserve('task', initial.roundId, request('logical', 'compaction'))).toThrow('budget-stale');
  expect(() => f.authority.reserve('task', initial.roundId, request('missing-first', 'conversation', 2))).toThrow('budget-stale');
  f.authority.reserve('task', initial.roundId, request('compact', 'compaction'));
  expect(() => f.authority.reserve('task', initial.roundId, request('over'))).toThrow('budget-exhausted');
  expect(f.task().requestCount).toBe(3);
});
it('retains consumed allowance through lost acknowledgment and reopening the database', () => {
  const f = fixture(); const initial = f.authority.current('task'); f.lostAck(true);
  expect(() => f.authority.reserve('task', initial.roundId, request('lost'))).toThrow('acknowledgment lost');
  f.lostAck(false);
  const reopened = new SqliteStore(f.file); cleanups.push(() => reopened.close());
  expect(reopened.get<TaskView>('tasks', 'task')?.budget?.roundUsed).toBe(1);
  const duplicate = f.authority.reserve('task', initial.roundId, request('lost'));
  expect(duplicate).toMatchObject({ duplicate: true, budget: { roundUsed: 1 } });
});
it('rolls back both task and attempt receipt on a storage failure and does not update memory', () => {
  const f = fixture(); const initial = f.authority.current('task');
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementationOnce((bucket, id, value) => {
    put(bucket, id, value); // Fail AFTER the write, while the real transaction is open.
    throw new Error('simulated budget disk failure');
  });
  expect(() => f.authority.reserve('task', initial.roundId, request('failed'))).toThrow('simulated budget disk failure');
  expect(f.task().budget).toEqual(initial);
  expect(f.store.get<TaskView>('tasks', 'task')?.budget).toEqual(initial);
  expect(f.store.requestBudgetReceipt('task:task', 'attempt:failed/1')).toBeUndefined();
});
it('rejects stale read sets and inconsistent memory instead of overwriting a newer budget', () => {
  const f = fixture(); const initial = f.authority.current('task');
  const commit = f.store.commitRequestBudget.bind(f.store);
  vi.spyOn(f.store, 'commitRequestBudget').mockImplementationOnce((change) => {
    f.store.put('tasks', 'task', { ...f.task(), budget: { ...initial, budgetRevision: 4 } });
    commit(change);
  });
  expect(() => f.authority.reserve('task', initial.roundId, request('stale'))).toThrow('Budget source changed');
  expect(f.task().budget).toEqual(initial);
  expect(() => f.authority.current('task')).toThrow('budget-stale');
  f.reload(); expect(f.authority.current('task').budgetRevision).toBe(4);
  expect(f.task().requestCount).toBe(0);
});
it('does not refill unfinished legacy work, and a real independent input after completion opens a fresh round', () => {
  const f = fixture(1000, 100);
  f.update({ status: 'paused', resumeReason: 'report' }, { modelIdle: true, reportPending: true });
  const legacy = f.authority.current('task');
  expect(legacy).toMatchObject({ roundUsed: 100, roundLimit: 100, totalUsed: 1000, origin: 'legacy' });
  expect(f.authority.input('task', 'continue').budget).toEqual(legacy);
  f.update({ status: 'answered', resumeReason: undefined }, { answered: true, reportPending: false });
  f.authority.complete('task');
  expect(f.authority.input('task', 'continue').duplicate).toBe(true);
  const fresh = f.authority.input('task', 'new-work');
  expect(fresh.budget).toMatchObject({ roundUsed: 0, roundLimit: 100, totalUsed: 1000 });
  expect(fresh.budget.roundId).not.toBe(legacy.roundId);
  f.update({ status: 'running' }, { modelIdle: false, answered: false });
  expect(() => f.authority.reserve('task', legacy.roundId, request('old'))).toThrow('budget-stale');
  expect(f.authority.reserve('task', fresh.budget.roundId, request('new')).budget.totalUsed).toBe(1001);
});
it('invalidates a previous completion for new pending work without replenishing it', () => {
  const f = fixture(1, 1);
  f.update({ status: 'answered' }, { answered: true, modelIdle: true });
  const closed = f.authority.complete('task'); expect(closed.closed).toBe(true);
  f.update({ status: 'paused', resumeReason: 'verify' }, { unresolved: true });
  const pending = f.authority.input('task', 'inspect-unknown').budget;
  expect(pending).toMatchObject({ roundId: closed.roundId, closed: false, roundUsed: 1, roundLimit: 1 });
});
it('adds exactly 100 once, preserves safety stops, and claims continuation only once even after a lost reply', () => {
  const f = fixture(1, 1);
  f.update({ status: 'paused', resumeReason: 'verify', summary: 'must verify' }, { modelIdle: true, unresolved: true, remoteIdle: false });
  const initial = f.authority.current('task');
  const input = { taskId: 'task', requestId: 'grant', roundId: initial.roundId, budgetRevision: initial.budgetRevision };
  f.lostAck(true);
  expect(() => f.authority.extend(input)).toThrow('acknowledgment lost');
  f.lostAck(false);
  const repeated = f.authority.extend(input);
  expect(repeated).toMatchObject({ duplicate: true, budget: { roundUsed: 1, roundLimit: 101 }, grant: { phase: 'granted' } });
  expect(f.task()).toMatchObject({ status: 'paused', resumeReason: 'verify', summary: 'must verify' });
  expect(() => f.authority.extend({ ...input, requestId: 'second-click' })).toThrow('budget-stale');
  expect(f.authority.advanceGrant('task', 'grant', 'granted', 'dispatching').changed).toBe(true);
  expect(f.authority.advanceGrant('task', 'grant', 'granted', 'dispatching').changed).toBe(false);
  expect(f.authority.extend(input).grant.phase).toBe('dispatching');
  expect(f.authority.advanceGrant('task', 'grant', 'dispatching', 'acknowledged').changed).toBe(true);
  expect(f.authority.extend(input).budget.roundLimit).toBe(101);
  expect(() => f.authority.advanceGrant('task', 'grant', 'acknowledged', 'granted')).toThrow('budget-stale');
});
it('cannot spend while inactive or manufacture allowance from corrupt saved state', () => {
  const f = fixture(2, 3); const initial = f.authority.current('task');
  f.update({ status: 'paused' }, { modelIdle: true });
  expect(() => f.authority.reserve('task', initial.roundId, request('stopped'))).toThrow('not active');
  f.update({ budget: { ...initial, roundUsed: -1 } });
  expect(() => f.authority.current('task')).toThrow('budget-invalid');
});
it('rejects extra payload fields, non-fixed increments and control characters before recording anything', () => {
  const f = fixture(1, 1); const initial = f.authority.current('task');
  const injected = { ...request('bad'), apiKey: 'fixture-private-key' };
  expect(() => f.authority.reserve('task', initial.roundId, injected)).toThrow('budget-invalid');
  expect(() => f.authority.reserve('task', initial.roundId, request('bad\n'))).toThrow('budget-invalid');
  const input = { taskId: 'task', requestId: 'grant', roundId: initial.roundId, budgetRevision: initial.budgetRevision, amount: 1000 };
  expect(() => f.authority.extend(input)).toThrow('budget-invalid');
  expect(f.store.requestBudgetReceipt('task:task', 'attempt:bad/1')).toBeUndefined();
  expect(f.task().budget).toEqual(initial);
});
it('does not interpret explicit null records as missing state or create replacement allowance', () => {
  const f = fixture();
  f.store.put('tasks', 'task', { ...f.task(), budget: null }); f.reload();
  expect(() => f.authority.current('task')).toThrow('budget-invalid');
  expect(f.store.requestBudgetReceipt('task:task', 'initialize')).toBeUndefined();
  f.store.put('request-budget-scopes', 'aux:summary:invalid', null);
  expect(() => f.authority.reserveAuxiliary('summary', 'invalid', request('new', 'summary'))).toThrow('budget-invalid');
  expect(f.store.get('request-budget-scopes', 'aux:summary:invalid')).toBeNull();
});
it('durably bounds summary and review scopes, including individual HTTP retries, independently of main usage', () => {
  const f = fixture();
  for (let index = 0; index < 32; index++) f.authority.reserveAuxiliary('summary', 'document', request(`summary-${index}`, 'summary'));
  expect(() => f.authority.reserveAuxiliary('summary', 'document', request('too-many', 'summary'))).toThrow('summary-budget-exhausted');
  expect(f.authority.reserveAuxiliary('summary', 'document', request('summary-0', 'summary')).used).toBe(32);
  for (let index = 1; index <= 3; index++) f.authority.reserveAuxiliary('review', 'review', request('review-request', 'review', index));
  expect(() => f.authority.reserveAuxiliary('review', 'review', request('extra', 'review'))).toThrow('review-budget-exhausted');
  expect(f.task().requestCount).toBe(0);
  f.store.put('request-budget-scopes', 'aux:summary:document', { purpose: 'summary', scopeId: 'document', used: 0, limit: 999 });
  expect(() => f.authority.reserveAuxiliary('summary', 'document', request('summary-0', 'summary'))).toThrow('budget-invalid');
});
