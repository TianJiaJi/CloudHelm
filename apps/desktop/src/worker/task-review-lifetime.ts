import { ReviewInterruptedError } from '@cloudhelm/core';

/** Revoke only model review/approval work; never imply a remote process exited. */
export class TaskReviewLifetime {
  private controller = new AbortController();
  private closed = false;
  signal(): AbortSignal { return this.controller.signal; }
  invalidate(outcome: 'canceled' | 'stale' = 'stale'): void {
    this.controller.abort(new ReviewInterruptedError(outcome));
    if (!this.closed) this.controller = new AbortController();
  }
  close(): void { this.closed = true; this.invalidate('canceled'); }
}
