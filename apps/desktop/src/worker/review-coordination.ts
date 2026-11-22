/** Review outcomes and their coordination effect, kept separate from the audit record.
 *
 * A refused operation is always a refusal: nothing was executed and the safety layer
 * keeps that guarantee on its own. What differs is the coordination consequence:
 * - none: the model can act on the refusal. Request errors are correctable, and an
 *   independent review denial is per-operation feedback (the refusal text tells the
 *   model not to retry or rewrap, and the user may still request exact manual review).
 * - pause-round: a policy refusal, a failed safety component or an unresolved user
 *   decision needs the user, so the whole round stops instead of inviting workarounds.
 */
export type ReviewCoordination = 'none' | 'diagnosis-only' | 'pause-round';

/** Errors that describe the proposed request, never the state of the host. */
const CORRECTABLE_ERRORS = new Set([
  'parse-failed', 'path-opaque', 'local-scope', 'invalid-process-control',
  'policy-stale', 'conversation-policy-stale', 'reviewer-stale',
  'analyzer-missing', 'script-changed', 'authorization-expired'
]);

/** Per-operation refusals that already carry their own next step to the model. */
const PER_OPERATION_REFUSALS = new Set([
  // Independent review denial: the tool result binds the exact denied intent and
  // offers a one-time manual review. Repeating it under a new ID stays blocked.
  'ai-review-deny',
  // An independent review that could not run is a refusal to execute, not a host fact;
  // the model may propose a safer operation instead of forcing a human decision.
  'ai-review-unavailable'
]);

export function reviewCoordination(decision: { verdict: string; ruleId: string }): ReviewCoordination {
  if (decision.verdict === 'allow' || decision.verdict === 'ask' || decision.verdict === 'evaluate') return 'none';
  if (decision.ruleId === 'human-denied') return 'diagnosis-only';
  if (decision.ruleId === 'continuation-read-only' || PER_OPERATION_REFUSALS.has(decision.ruleId)) return 'none';
  if (decision.verdict === 'error' && CORRECTABLE_ERRORS.has(decision.ruleId)) return 'none';
  return 'pause-round';
}
