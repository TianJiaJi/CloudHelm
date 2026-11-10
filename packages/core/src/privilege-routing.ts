import type { OperationResult } from './model.js';

/** Eligibility, not authorization. The next identity and operation still need review. */
export function canOfferSuFallback(result: OperationResult): boolean {
  const feedback = result.privilege;
  return result.status === 'failed' && result.effects === 'none'
    && !result.requiresUserAction && result.authentication !== 'failed'
    && feedback?.method === 'sudo' && feedback.source === 'transport'
    && feedback.businessCommand === 'not-started'
    && ['sudo-unavailable', 'authorization-denied'].includes(feedback.code)
    && feedback.recovery === 'confirm-alternative'
    && Number.isInteger(result.exitCode) && result.exitCode! > 0;
}
