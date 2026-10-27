import { assertRequestBudget, remainingRequests, RequestBudgetError, type ModelRequestAttempt, type RequestBudgetState } from '@cloudhelm/core';
import type { BudgetCommand, BudgetValue } from '@cloudhelm/contracts';

export type BudgetPort = (command: BudgetCommand, signal?: AbortSignal) => Promise<BudgetValue>;

/** Worker holds no allowance. Every send obtains a fresh durable Main receipt. */
export class TaskRequestBudget {
  constructor(private readonly taskId: string, private readonly request?: BudgetPort) {}

  private async call(command: BudgetCommand, signal?: AbortSignal): Promise<BudgetValue> {
    signal?.throwIfAborted();
    if (!this.request) throw new Error('预算确认不可用，不能发送模型请求。');
    const result = await this.request(command, signal);
    signal?.throwIfAborted();
    return result;
  }

  async current(signal?: AbortSignal): Promise<RequestBudgetState> {
    const result = await this.call({ kind: 'current', taskId: this.taskId }, signal);
    if (result.kind !== 'current' || result.taskId !== this.taskId) throw new RequestBudgetError('budget-stale');
    assertRequestBudget(result.budget);
    return structuredClone(result.budget);
  }

  async assertAvailable(signal?: AbortSignal): Promise<void> {
    const state = await this.current(signal);
    if (state.closed) throw new RequestBudgetError('budget-round-closed');
    if (remainingRequests(state) <= 0) throw new RequestBudgetError('budget-exhausted');
  }

  async reserve(attempt: ModelRequestAttempt, signal?: AbortSignal, preparationId?: string): Promise<RequestBudgetState> {
    if (preparationId !== undefined && attempt.purpose !== 'compaction') throw new RequestBudgetError('budget-invalid');
    const current = await this.current(signal);
    const result = await this.call({ kind: 'reserve', taskId: this.taskId, roundId: current.roundId, attempt,
      ...(preparationId === undefined ? {} : { preparationId }) }, signal);
    if (result.kind !== 'reserve' || result.taskId !== this.taskId || result.preparationId !== preparationId) throw new RequestBudgetError('budget-stale');
    assertRequestBudget(result.budget);
    if (result.budget.closed || result.budget.roundId !== current.roundId || result.budget.roundUsed < 1
      || result.budget.totalUsed < current.totalUsed) throw new RequestBudgetError('budget-stale');
    return structuredClone(result.budget);
  }
}
