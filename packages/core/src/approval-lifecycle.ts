/** Internal port interruption, distinct from an explicit human false decision.
 * Fixed metadata only; no provider exception or user input is carried here. */
export type ApprovalInterruption = 'canceled' | 'expired' | 'stale';
export class ApprovalInterruptedError extends Error {
  constructor(readonly outcome: ApprovalInterruption) {
    super(`Approval interrupted: ${outcome}`);
    this.name = 'ApprovalInterruptedError';
  }
}
