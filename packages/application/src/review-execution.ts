import { ReviewInterruptedError, type CommandAnalysis, type OperationAdjudication, type ProposedOperation, type RiskAssessment, type RiskEvaluator } from '@cloudhelm/core';
import type { AdjudicationBinding, AdjudicationRegistry } from './adjudication-registry.js';

type Assessment = RiskAssessment | RiskAssessment['verdict'];
export type ReviewExecution = { kind: 'assessment'; assessment: Assessment } | { kind: 'canceled' | 'stale' | 'timeout' };

export type AdjudicationVerification =
  | { kind: 'confirmed'; binding: AdjudicationBinding; adjudication: OperationAdjudication }
  | { kind: 'receipt' }
  | { kind: 'escalate'; cause: string };

function validAdjudicationShape(entry: OperationAdjudication): boolean {
  return typeof entry.adjudicationId === 'string' && entry.adjudicationId.length > 0 && entry.adjudicationId.length <= 200
    && typeof entry.confirmed === 'boolean' && Array.isArray(entry.basis) && entry.basis.length >= 1 && entry.basis.length <= 8
    && entry.basis.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 512);
}

/** Verify a same-proposer re-proposal against its minted binding. Any entry that
 * targets this exact fingerprint but fails verification permanently denies the
 * binding and escalates to a human; entries bound to other fingerprints are
 * ignored so composite tool flows can carry their whole confirmation history. */
export function verifyAdjudicationReproposal(operation: ProposedOperation, fingerprint: string,
  registry: AdjudicationRegistry, now = Date.now()): AdjudicationVerification {
  const escalations: string[] = [];
  for (const entry of operation.adjudications ?? []) {
    if (!validAdjudicationShape(entry)) return { kind: 'escalate', cause: 'invalid-adjudication' };
    const binding = registry.find(entry.adjudicationId);
    if (!binding || binding.fingerprint !== fingerprint) continue;
    if (entry.confirmed === false) { registry.deny(binding.id); return { kind: 'escalate', cause: 'declined' }; }
    if (binding.state !== 'pending') {
      // Read the terminal state before deny() clobbers it.
      const cause = binding.state === 'consumed' ? 'already-consumed' : 'binding-denied';
      registry.deny(binding.id);
      return { kind: 'escalate', cause };
    }
    if (now >= binding.expiresAt) { registry.deny(binding.id); return { kind: 'escalate', cause: 'expired' }; }
    if (binding.taskId !== operation.scope.taskId || binding.hostId !== operation.scope.hostId) {
      registry.deny(binding.id); return { kind: 'escalate', cause: 'scope-mismatch' };
    }
    if (registry.consume(binding.id)) return { kind: 'confirmed', binding, adjudication: entry };
    registry.deny(binding.id);
    escalations.push('binding-denied');
  }
  return escalations.length > 0 ? { kind: 'escalate', cause: escalations[0]! } : { kind: 'receipt' };
}

/** Bound both the transport and the await. A noncooperative reviewer may settle
 * later, but its result/rejection has no continuation into approval or execution. */
export async function executeReview(evaluator: RiskEvaluator, operation: ProposedOperation, analysis: CommandAnalysis | undefined,
  context: Parameters<RiskEvaluator['evaluate']>[2], isCurrent: () => boolean,
  caller?: AbortSignal, lifetime?: AbortSignal): Promise<ReviewExecution> {
  const interruption = (): 'canceled' | 'stale' | undefined => caller?.aborted ? 'canceled'
    : lifetime?.aborted ? lifetime.reason instanceof ReviewInterruptedError && lifetime.reason.outcome === 'canceled' ? 'canceled' : 'stale'
      : !isCurrent() ? 'stale' : undefined;
  const before = interruption();
  if (before) return { kind: before };
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal, ...(caller ? [caller] : []), ...(lifetime ? [lifetime] : [])]);
  let stop!: () => void;
  const interrupted = new Promise<undefined>((resolve) => { stop = () => resolve(undefined); });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  try {
    const response = Promise.resolve().then(() => {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Review authorization expired');
      return evaluator.evaluate(operation, analysis, context, signal);
    }).catch((): RiskAssessment => ({ verdict: 'error', reason: '审核模型调用失败' }));
    const assessment = await Promise.race([response, interrupted]);
    const stopped = interruption();
    if (stopped) return { kind: stopped };
    if (deadline.signal.aborted) return { kind: 'timeout' };
    return { kind: 'assessment', assessment: assessment ?? { verdict: 'error', reason: '审核未返回有效结果' } };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
