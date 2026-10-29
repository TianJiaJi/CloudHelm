import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { BudgetCommand, BudgetRequestMessage, TaskView } from '@cloudhelm/contracts';
import { RequestBudgetClient } from '../../../apps/desktop/src/worker/request-budget-client.js';
import { RequestBudgetAuthority } from '../../../apps/desktop/src/main/request-budget-authority.js';
import { createBudgetRequestHandler } from '../../../apps/desktop/src/main/request-budget-broker.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const store = new SqliteStore(':memory:'); cleanups.push(() => store.close());
  let task: TaskView = { id: 'task', goal: 'private fixture goal', hostIds: [], localScopes: [], modelId: 'fixture',
    status: 'running', requestCount: 0, requestLimit: 2, createdAt: 1, updatedAt: 1 };
  store.put('tasks', task.id, task);
  const authority = new RequestBudgetAuthority(store, { task: () => task, replace: (value) => { task = value; },
    completion: () => ({ answered: false, unresolved: false, reportPending: false, modelIdle: false, remoteIdle: true }) });
  const allowed = new Set(['task:task', 'summary:document', 'review:task:operation']);
  const authorize = vi.fn((command: Readonly<BudgetCommand>) => {
    const key = command.kind === 'summary' ? `summary:${command.requestId}`
      : command.kind === 'review' ? `review:${command.taskId}:${command.operationId}` : `task:${command.taskId}`;
    if (!allowed.has(key)) throw new Error('private scope authorization details');
  });
  const handler = createBudgetRequestHandler(authority, authorize);
  const initial = authority.current('task');
  const attempt = { logicalRequestId: 'logical', purpose: 'conversation' as const, attempt: 1, transport: 'http' as const };
  const command: Extract<BudgetCommand, { kind: 'reserve' }> = { kind: 'reserve', taskId: 'task', roundId: initial.roundId, attempt };
  return { store, authority, handler, command, allowed, authorize, task: () => task };
}
it('only acknowledges after durable commit and never exposes the task goal or credentials', () => {
  const f = fixture(); const result = f.handler(f.command);
  expect(result).toMatchObject({ value: { kind: 'reserve', budget: { roundUsed: 1, totalUsed: 1 } } });
  expect(f.store.get<TaskView>('tasks', 'task')?.requestCount).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private fixture goal');
  expect(f.handler(f.command)).toMatchObject({ value: { duplicate: true, budget: { roundUsed: 1 } } });
  expect(f.handler({ ...f.command, attempt: { ...f.command.attempt, logicalRequestId: 'two' } })).toMatchObject({ value: { budget: { roundUsed: 2 } } });
  expect(f.handler({ ...f.command, attempt: { ...f.command.attempt, logicalRequestId: 'three' } })).toEqual({ error: 'budget-exhausted' });
});
it('rejects unauthorized or revoked scopes before minting any auxiliary allowance', () => {
  const f = fixture();
  const request = { kind: 'summary', requestId: 'forged', attempt: { ...f.command.attempt, purpose: 'summary' } };
  expect(f.handler(request)).toEqual({ error: 'budget-unavailable' });
  expect(f.store.list('request-budget-scopes')).toEqual([]);
  expect(f.handler({ ...request, requestId: 'document' })).toEqual({ value: { kind: 'summary', scopeId: 'document', used: 1, limit: 32 } });
  f.allowed.delete('summary:document');
  expect(f.handler({ ...request, requestId: 'document' })).toEqual({ error: 'budget-unavailable' });
  expect(f.store.get('request-budget-scopes', 'aux:summary:document')).toMatchObject({ used: 1 });
  expect(f.handler({ kind: 'review', taskId: 'foreign', operationId: 'operation', attempt: { ...f.command.attempt, purpose: 'review' } }))
    .toEqual({ error: 'budget-unavailable' });
});
it('does not authorize malformed requests and suppresses storage failure details', () => {
  const f = fixture();
  expect(f.handler({ ...f.command, apiKey: 'private key' })).toEqual({ error: 'budget-invalid' });
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.handler({ ...f.command, attempt: { ...f.command.attempt, purpose: 'review' } })).toEqual({ error: 'budget-invalid' });
  vi.spyOn(f.store, 'commitRequestBudget').mockImplementationOnce(() => { throw new Error('private database path and token'); });
  expect(f.handler(f.command)).toEqual({ error: 'budget-unavailable' });
  expect(f.task().requestCount).toBe(0);
});
it('keeps the durable charge when cancellation wins the acknowledgment race, without dispatching or refunding', async () => {
  const f = fixture(); const outbound: BudgetRequestMessage[] = [];
  const client = new RequestBudgetClient((message) => { outbound.push(message); }); cleanups.push(() => client.close());
  const signal = new AbortController(); const dispatch = vi.fn();
  const pending = client.request(f.command, signal.signal).then(dispatch);
  const rejected = expect(pending).rejects.toThrow('取消');
  const sent = outbound[0]!.budgetRequest;
  const committed = f.handler(sent.command);
  expect(f.task().requestCount).toBe(1);
  signal.abort(); await rejected;
  client.resolve({ id: sent.id, ...committed });
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.task().requestCount).toBe(1);
  expect(outbound).toHaveLength(1);
});
