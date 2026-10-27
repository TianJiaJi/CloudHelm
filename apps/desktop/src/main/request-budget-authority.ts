import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import type { SqliteStore } from '@cloudhelm/adapters';
import { assertAuxiliaryBudget, assertModelRequestAttempt, assertRequestBudget, beginRequestRound, closeRequestRound, createAuxiliaryBudget,
  extendRequestRound, legacyRequestBudget, reopenRequestRound, requestAttemptKey, reserveAuxiliaryRequest,
  reserveRoundRequest, RequestBudgetError, type AuxiliaryRequestBudget, type ModelRequestAttempt,
  type RequestBudgetState, type RoundCompletion } from '@cloudhelm/core';
import { ExtendRequestBudgetSchema, type ExtendRequestBudget, type RequestBudgetGrant, type TaskView } from '@cloudhelm/contracts';

interface AuthorityState {
  task(id: string): TaskView;
  /** Called only AFTER durable commit. No worker-supplied counter is authoritative. */
  replace(task: TaskView): void;
  completion(id: string): RoundCompletion;
}
interface Receipt {
  kind: 'initialize' | 'attempt' | 'input' | 'close' | 'reopen' | 'extension';
  roundId?: string;
  preparationId?: string;
  request?: ModelRequestAttempt;
  grant?: RequestBudgetGrant;
}
function stale(): never { throw new RequestBudgetError('budget-stale'); }

/** Main-process authority. All methods are synchronous compare-and-commit operations.
 * These receipts account for reservations, not proof of HTTP delivery, and NEVER
 * authorize replay of a model request, remote command, or a stopped continuation. */
export class RequestBudgetAuthority {
  constructor(private readonly store: SqliteStore, private readonly state: AuthorityState) {}

  current(taskId: string): RequestBudgetState {
    const { task, stored } = this.read(taskId);
    if (task.budget !== undefined) { assertRequestBudget(task.budget); return structuredClone(task.budget); }
    const budget = legacyRequestBudget(randomUUID(), task.requestCount, task.requestLimit);
    this.commit(task, stored, budget, 'initialize', 'initialize-v1', { kind: 'initialize', roundId: budget.roundId });
    return structuredClone(budget);
  }

  /** preparationId is accepted only after the broker authorizes the live job. */
  reserve(taskId: string, roundId: string, request: ModelRequestAttempt, preparationId?: string): { budget: RequestBudgetState; duplicate: boolean } {
    assertModelRequestAttempt(request);
    if (request.purpose !== 'conversation' && request.purpose !== 'compaction') throw new RequestBudgetError('budget-invalid');
    const budget = this.current(taskId);
    const { task, stored } = this.read(taskId);
    if (budget.roundId !== roundId) stale();
    if (budget.closed) throw new RequestBudgetError('budget-round-closed');
    if (preparationId !== undefined) {
      createAuxiliaryBudget('summary', preparationId); // Same strict bounded ID validation; no allowance is created.
      if (request.purpose !== 'compaction') throw new RequestBudgetError('budget-invalid');
      if (!['answered', 'paused', 'failed', 'human-control', 'recovering'].includes(task.status)) throw new Error('Preparation is not idle');
      const input = this.existing(this.owner(taskId), `input:${preparationId}`,
        JSON.stringify({ kind: 'input', taskId, requestId: preparationId }));
      if (input?.kind !== 'input' || input.roundId !== roundId) stale();
    } else if (task.status !== 'running') throw new Error('Budget request is not active');
    const marker = this.roundInput(taskId, budget);
    const value: Receipt = { kind: 'attempt', roundId, request: { ...request }, ...(preparationId === undefined ? {} : { preparationId }) };
    const binding = JSON.stringify(value); const key = `attempt:${requestAttemptKey(request)}`;
    if (this.existing(this.owner(taskId), key, binding)) return { budget, duplicate: true };
    this.predecessor(this.owner(taskId), request, roundId, preparationId);
    const next = reserveRoundRequest(budget);
    const input = marker;
    const records = request.purpose === 'conversation' && input?.awaitingRequest
      ? [{ bucket: 'request-round-inputs', id: taskId, before: input, value: { ...input, awaitingRequest: false } }] : [];
    this.commit(task, stored, next, key, binding, value, records);
    return { budget: structuredClone(next), duplicate: false };
  }

  /** Invoke only at Main's genuine input boundary, never on resume/steer callbacks,
   * clarification display replay, or a request made by a business tool. */
  input(taskId: string, requestId: string): { budget: RequestBudgetState; duplicate: boolean } {
    // Reuse the bounded internal identifier validation without accepting arbitrary text.
    createAuxiliaryBudget('summary', requestId);
    const budget = this.current(taskId);
    const { task, stored } = this.read(taskId);
    const key = `input:${requestId}`; const binding = JSON.stringify({ kind: 'input', taskId, requestId });
    if (this.existing(this.owner(taskId), key, binding)) return { budget, duplicate: true };
    const facts = this.state.completion(taskId);
    // A persisted clean close survives idle restoration, but new pending work
    // invalidates that close without refilling the old round.
    const input = this.roundInput(taskId, budget);
    const pending = input?.awaitingRequest || facts.unresolved || facts.reportPending || !facts.modelIdle || !facts.remoteIdle;
    const completed = pending ? reopenRequestRound(budget) : closeRequestRound(budget, facts);
    const next = completed.closed ? beginRequestRound(completed, randomUUID()) : completed;
    this.commit(task, stored, next, key, binding, { kind: 'input', roundId: next.roundId },
      [{ bucket: 'request-round-inputs', id: taskId, before: input,
        value: { version: 1, roundId: next.roundId, awaitingRequest: input?.awaitingRequest === true || next.roundId !== budget.roundId } }]);
    return { budget: structuredClone(next), duplicate: false };
  }

  complete(taskId: string): RequestBudgetState {
    const budget = this.current(taskId);
    const next = this.roundInput(taskId, budget)?.awaitingRequest ? budget : closeRequestRound(budget, this.state.completion(taskId));
    if (next !== budget) {
      const { task, stored } = this.read(taskId);
      const key = `close:${budget.budgetRevision}`;
      this.commit(task, stored, next, key, key, { kind: 'close', roundId: budget.roundId });
    }
    return structuredClone(next);
  }

  reopen(taskId: string): RequestBudgetState {
    const budget = this.current(taskId); const next = reopenRequestRound(budget);
    if (next !== budget) {
      const { task, stored } = this.read(taskId);
      const key = `reopen:${budget.budgetRevision}`;
      this.commit(task, stored, next, key, key, { kind: 'reopen', roundId: budget.roundId });
    }
    return structuredClone(next);
  }

  extend(input: ExtendRequestBudget): { budget: RequestBudgetState; grant: RequestBudgetGrant; duplicate: boolean } {
    if (!Value.Check(ExtendRequestBudgetSchema, input)) throw new RequestBudgetError('budget-invalid');
    const budget = this.current(input.taskId); const { task, stored } = this.read(input.taskId);
    const key = `extension:${input.requestId}`;
    const binding = JSON.stringify({ taskId: input.taskId, requestId: input.requestId,
      roundId: input.roundId, budgetRevision: input.budgetRevision });
    const prior = this.existing(this.owner(input.taskId), key, binding);
    if (prior) {
      if (prior.kind !== 'extension' || !prior.grant) stale();
      return { budget, grant: structuredClone(prior.grant), duplicate: true };
    }
    if (!this.state.completion(input.taskId).modelIdle) throw new Error('Wait for the model request to stop before extending its budget');
    const next = extendRequestRound(budget, input);
    const grant: RequestBudgetGrant = { requestId: input.requestId, roundId: input.roundId, phase: 'granted' };
    this.commit(task, stored, next, key, binding, { kind: 'extension', roundId: input.roundId, grant });
    // Extending never changes status, safety stops, intent, or operation state.
    return { budget: structuredClone(next), grant: { ...grant }, duplicate: false };
  }

  /** Claim before calling the worker. A lost continuation acknowledgment remains
   * dispatching, so duplicate clicks/restarts do not automatically resume again. */
  advanceGrant(taskId: string, requestId: string, from: RequestBudgetGrant['phase'], to: RequestBudgetGrant['phase']): { grant: RequestBudgetGrant; changed: boolean } {
    if (!((from === 'granted' && to === 'dispatching') || (from === 'dispatching' && to === 'acknowledged'))) stale();
    const owner = this.owner(taskId); const key = `extension:${requestId}`;
    const prior = this.store.requestBudgetReceipt<Receipt>(owner, key);
    if (!prior?.value.grant || prior.value.kind !== 'extension') stale();
    if (prior.value.grant.phase === to) return { grant: structuredClone(prior.value.grant), changed: false };
    if (prior.value.grant.phase !== from) stale();
    if (to === 'dispatching' && this.current(taskId).roundId !== prior.value.grant.roundId) stale();
    const grant = { ...prior.value.grant, phase: to };
    this.store.commitRequestBudget({ records: [], receipt: { owner, requestId: key, binding: prior.binding,
      before: prior.value, value: { ...prior.value, grant } } });
    return { grant, changed: true };
  }

  /** The IPC broker must bind scopeId to its active preparation or review first.
   * Cancellation does not delete/refill a previously consumed auxiliary scope. */
  reserveAuxiliary(purpose: 'summary' | 'review', scopeId: string, request: ModelRequestAttempt): AuxiliaryRequestBudget {
    assertModelRequestAttempt(request);
    if (request.purpose !== purpose) throw new RequestBudgetError('budget-invalid');
    const initial = createAuxiliaryBudget(purpose, scopeId);
    const owner = `aux:${purpose}:${scopeId}`;
    const stored = this.store.get<AuxiliaryRequestBudget>('request-budget-scopes', owner);
    const state = stored === undefined ? initial : stored;
    assertAuxiliaryBudget(state);
    if (state.purpose !== purpose || state.scopeId !== scopeId) stale();
    const value: Receipt = { kind: 'attempt', request: { ...request } }; const binding = JSON.stringify(value);
    const key = `attempt:${requestAttemptKey(request)}`;
    if (this.existing(owner, key, binding)) return structuredClone(state);
    this.predecessor(owner, request);
    const next = reserveAuxiliaryRequest(state);
    this.store.commitRequestBudget({ records: [{ bucket: 'request-budget-scopes', id: owner, before: stored, value: next }],
      receipt: { owner, requestId: key, binding, value } });
    return structuredClone(next);
  }

  private owner(taskId: string): string { return `task:${taskId}`; }
  private existing(owner: string, key: string, binding: string): Receipt | undefined {
    const receipt = this.store.requestBudgetReceipt<Receipt>(owner, key);
    if (receipt && receipt.binding !== binding) stale();
    return receipt?.value;
  }
  private predecessor(owner: string, request: ModelRequestAttempt, roundId?: string, preparationId?: string): void {
    if (request.attempt === 1) return;
    const prior = this.store.requestBudgetReceipt<Receipt>(owner, `attempt:${request.logicalRequestId}/${request.attempt - 1}`)?.value;
    if (prior?.roundId !== roundId || prior?.preparationId !== preparationId || prior?.request?.purpose !== request.purpose || prior.request.transport !== request.transport) stale();
  }
  private read(taskId: string): { task: TaskView; stored: TaskView } {
    const task = structuredClone(this.state.task(taskId));
    const stored = this.store.get<TaskView>('tasks', taskId);
    if (!stored || stored.id !== taskId || task.id !== taskId || JSON.stringify(stored.budget) !== JSON.stringify(task.budget)
      || (task.budget && (stored.requestCount !== task.budget.totalUsed || task.requestCount !== task.budget.totalUsed))) stale();
    return { task, stored };
  }
  private roundInput(taskId: string, budget: RequestBudgetState): { version: 1; roundId: string; awaitingRequest: boolean } | undefined {
    const value = this.store.get<{ version: 1; roundId: string; awaitingRequest: boolean }>('request-round-inputs', taskId);
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'awaitingRequest,roundId,version'
      || value.version !== 1 || value.roundId !== budget.roundId || typeof value.awaitingRequest !== 'boolean') stale();
    return value;
  }
  private commit(task: TaskView, stored: TaskView, budget: RequestBudgetState, requestId: string, binding: string, value: Receipt,
    records: Parameters<SqliteStore['commitRequestBudget']>[0]['records'] = []): void {
    const fields = { budget: structuredClone(budget), requestCount: budget.totalUsed, updatedAt: Date.now() };
    this.store.commitRequestBudget({ records: [{ bucket: 'tasks', id: task.id, before: stored, value: { ...stored, ...fields } }, ...records],
      receipt: { owner: this.owner(task.id), requestId, binding, value } });
    this.state.replace({ ...task, ...fields });
  }
}
