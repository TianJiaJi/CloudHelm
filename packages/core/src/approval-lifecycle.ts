/** Correlation and deadlines only; presentation fields do not own approval state. */
export interface ApprovalWaitBinding {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  fingerprint: string;
  expiresAt: number;
  hardExpiresAt?: number;
  renewals?: number;
}

/** Internal port interruption, distinct from an explicit human false decision.
 * Fixed metadata only; no provider exception or user input is carried here. */
export type ApprovalInterruption = 'canceled' | 'expired' | 'stale';
export class ApprovalInterruptedError extends Error {
  constructor(readonly outcome: ApprovalInterruption) {
    super(`Approval interrupted: ${outcome}`);
    this.name = 'ApprovalInterruptedError';
  }
}
