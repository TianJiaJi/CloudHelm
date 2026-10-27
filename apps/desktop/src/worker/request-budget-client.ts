import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { assertModelRequestAttempt, assertRequestBudget, RequestBudgetError } from '@cloudhelm/core';
import { BudgetCommandSchema, BudgetResultSchema, type BudgetCommand, type BudgetRequestMessage, type BudgetValue } from '@cloudhelm/contracts';

interface Pending {
  command: BudgetCommand;
  resolve(value: BudgetValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detach(): void;
}
const unavailable = () => new Error('预算确认不可用，未获得发送模型请求的许可。');
const cancelled = () => new DOMException('预算预留等待已取消。', 'AbortError');

/** A missing, failed or late acknowledgment is never an in-memory allowance.
 * Cancellation removes the waiter, NOT a reservation Main may have committed. */
export class RequestBudgetClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly post: (message: BudgetRequestMessage) => void, private readonly timeoutMs = 30_000,
    private readonly confirmed?: (command: BudgetCommand, value: BudgetValue) => void) {}

  async request(command: BudgetCommand, signal?: AbortSignal): Promise<BudgetValue> {
    if (!Value.Check(BudgetCommandSchema, command)) throw new RequestBudgetError('budget-invalid');
    if (command.kind !== 'current') assertModelRequestAttempt(command.attempt);
    if (this.closed) throw unavailable();
    if (signal?.aborted) throw cancelled();
    const id = randomUUID(); const snapshot = structuredClone(command);
    return new Promise<BudgetValue>((resolve, reject) => {
      const onAbort = () => this.reject(id, cancelled());
      const timer = setTimeout(() => this.reject(id, unavailable()), this.timeoutMs);
      this.pending.set(id, { command: snapshot, resolve, reject, timer,
        detach: () => signal?.removeEventListener('abort', onAbort) });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.post({ budgetRequest: { id, command: structuredClone(snapshot) } }); }
      catch { this.reject(id, unavailable()); }
    });
  }

  resolve(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') return;
    const pending = this.pending.get(raw.id);
    if (!pending) return; // Aborted, timed-out, duplicate or obsolete transport result.
    if (!Value.Check(BudgetResultSchema, raw)) { this.reject(raw.id, new RequestBudgetError('budget-invalid')); return; }
    if ('error' in raw) {
      this.reject(raw.id, raw.error === 'budget-unavailable' ? unavailable() : new RequestBudgetError(raw.error)); return;
    }
    try {
      const value = raw.value; const command = pending.command;
      if (command.kind !== value.kind) throw new RequestBudgetError('budget-invalid');
      if (value.kind === 'current' || value.kind === 'reserve') {
        assertRequestBudget(value.budget);
        if (!('taskId' in command) || command.taskId !== value.taskId) throw new RequestBudgetError('budget-stale');
        if (command.kind === 'reserve' && (value.kind !== 'reserve' || command.preparationId !== value.preparationId
          || command.roundId !== value.budget.roundId || value.budget.closed || value.budget.roundUsed < 1)) {
          throw new RequestBudgetError('budget-stale');
        }
      } else {
        const scopeId = command.kind === 'summary' ? command.requestId : command.kind === 'review' ? command.operationId : undefined;
        if (value.scopeId !== scopeId) throw new RequestBudgetError('budget-stale');
      }
      const clean = structuredClone(value);
      const waiter = this.take(raw.id);
      if (!waiter) return;
      try { this.confirmed?.(structuredClone(command), structuredClone(clean)); } catch { /* Diagnostics never authorize or revoke a charge. */ }
      waiter.resolve(clean);
    } catch (error) { this.reject(raw.id, error instanceof RequestBudgetError ? error : new RequestBudgetError('budget-invalid')); }
  }

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.reject(id, unavailable());
  }
  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.detach(); }
    return pending;
  }
  private reject(id: string, error: Error): void { this.take(id)?.reject(error); }
}
