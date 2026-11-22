import { ApprovalInterruptedError, type ApprovalInterruption, type ApprovalWaitBinding } from '@cloudhelm/core';

interface Pending<V> {
  view: V;
  hardExpiresAt: number;
  renewals: number;
  reminder?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  resolve(value: boolean): void;
  reject(error: Error): void;
}

export interface ApprovalEvents<V> {
  opened(view: V): void;
  reminder(id: string): void;
  closed(id: string): void;
}

/** Sole approval-wait owner. It holds no terminal, execution slot or dispatch
 * permission; a decision must still pass the gate and durable dispatch checks. */
export class ApprovalCoordinator<V extends ApprovalWaitBinding> {
  private readonly pending = new Map<string, Pending<V>>();
  private readonly usedIds = new Set<string>();
  private disposed = false;

  constructor(private readonly events: ApprovalEvents<V>) {}

  request(view: V): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('Approval coordinator unavailable'));
    const hard = view.hardExpiresAt ?? view.expiresAt;
    if (!Number.isSafeInteger(view.expiresAt) || !Number.isSafeInteger(hard) || hard < view.expiresAt)
      return Promise.reject(new Error('Invalid approval deadline'));
    if (view.expiresAt <= Date.now()) return Promise.reject(new ApprovalInterruptedError('expired'));
    if ([view.id, view.taskId, view.hostId, view.operationId, view.fingerprint].some((value) => typeof value !== 'string' || !value))
      return Promise.reject(new Error('Invalid approval binding'));
    if (this.usedIds.has(view.id)) return Promise.reject(new Error('Approval id already used'));
    const snapshot = structuredClone(view);
    this.usedIds.add(view.id);
    return new Promise<boolean>((resolve, reject) => {
      const wait: Pending<V> = { view: snapshot, hardExpiresAt: hard, renewals: 0,
        resolve: (value) => { this.clearTimers(wait); queueMicrotask(() => resolve(value)); },
        reject: (error) => { this.clearTimers(wait); reject(error); } };
      // Register before publication, including synchronous/reentrant responses.
      this.pending.set(view.id, wait);
      try { this.armTimers(wait); this.events.opened(structuredClone(snapshot)); }
      catch {
        this.pending.delete(view.id);
        wait.reject(new Error('Approval channel unavailable'));
      }
    });
  }

  decide(id: string, approved: unknown): void {
    const wait = this.pending.get(id);
    if (!wait) throw new Error('Approval expired');
    if (Date.now() >= wait.hardExpiresAt) {
      this.cancel(id, 'expired');
      throw new Error('Approval expired');
    }
    if (typeof approved !== 'boolean') throw new Error('Invalid approval decision');
    if (!this.settle(id, approved)) throw new Error('Approval channel unavailable');
  }

  renew(id: string, extendMs = 10 * 60_000): { expiresAt: number; hardExpiresAt: number } | undefined {
    const wait = this.pending.get(id);
    if (!wait) return undefined;
    // A delayed timer must not resurrect an expired wait.
    if (Date.now() >= wait.hardExpiresAt) { this.cancel(id, 'expired'); return undefined; }
    if (!Number.isSafeInteger(extendMs) || extendMs <= 0 || wait.renewals >= 5 || wait.hardExpiresAt <= wait.view.expiresAt) return undefined;
    const expiresAt = Math.min(Math.max(wait.view.expiresAt, Date.now()) + extendMs, wait.hardExpiresAt);
    wait.renewals++;
    wait.view = { ...wait.view, expiresAt, hardExpiresAt: wait.hardExpiresAt, renewals: wait.renewals };
    this.clearTimers(wait);
    try { this.armTimers(wait); this.events.opened(structuredClone(wait.view)); }
    catch { this.cancel(id); return undefined; }
    return { expiresAt, hardExpiresAt: wait.hardExpiresAt };
  }

  cancel(id: string, outcome: ApprovalInterruption = 'canceled'): void {
    this.settle(id, new ApprovalInterruptedError(outcome));
  }

  cancelWhere(predicate: (binding: Readonly<ApprovalWaitBinding>) => boolean, outcome: ApprovalInterruption = 'stale'): void {
    for (const [id, wait] of this.pending) if (predicate(structuredClone(wait.view))) this.cancel(id, outcome);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id);
    this.usedIds.clear();
  }

  private settle(id: string, value: boolean | ApprovalInterruptedError): boolean {
    const wait = this.pending.get(id);
    if (!wait) return false;
    this.pending.delete(id);
    try { this.events.closed(id); }
    catch { wait.reject(new Error('Approval channel unavailable')); return false; }
    if (value instanceof ApprovalInterruptedError) wait.reject(value);
    else wait.resolve(value);
    return true;
  }

  private clearTimers(wait: Pending<V>): void {
    if (wait.reminder !== undefined) clearTimeout(wait.reminder);
    if (wait.deadline !== undefined) clearTimeout(wait.deadline);
    wait.reminder = undefined; wait.deadline = undefined;
  }

  private armTimers(wait: Pending<V>): void {
    if (wait.hardExpiresAt > wait.view.expiresAt) wait.reminder = setTimeout(() => {
      wait.reminder = undefined;
      try { this.events.reminder(wait.view.id); }
      catch { this.cancel(wait.view.id); }
    }, Math.max(0, wait.view.expiresAt - Date.now()));
    wait.deadline = setTimeout(() => this.cancel(wait.view.id, 'expired'), Math.max(0, wait.hardExpiresAt - Date.now()));
  }
}
