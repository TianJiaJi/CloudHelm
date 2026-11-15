import { ReviewInterruptedError, type CommandAnalysis, type ProposedOperation, type RiskAssessment, type RiskEvaluator } from '@cloudhelm/core';

type Assessment = RiskAssessment | RiskAssessment['verdict'];
export type ReviewExecution = { kind: 'assessment'; assessment: Assessment } | { kind: 'canceled' | 'stale' | 'timeout' };

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
