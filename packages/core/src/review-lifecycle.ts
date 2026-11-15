/** Backend-only interruption metadata. Never carry provider errors or user text. */
export class ReviewInterruptedError extends Error {
  constructor(readonly outcome: 'canceled' | 'stale') {
    super(`Review interrupted: ${outcome}`);
    this.name = 'ReviewInterruptedError';
  }
}
