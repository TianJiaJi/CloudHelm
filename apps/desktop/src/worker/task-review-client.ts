import { AiRiskEvaluator, PiReviewClient, type ReviewClient } from '@cloudhelm/adapters';
import type { DiagnosticEvent, ProposedOperation, RiskAssessment } from '@cloudhelm/core';
import type { BudgetPort } from './task-request-budget.js';
import type { RuntimeProfile, RuntimeReviewProfile } from '@cloudhelm/contracts/runtime';

export function resolveTaskReviewer(profile: RuntimeProfile, reviewer: RuntimeReviewProfile): RuntimeReviewProfile {
  return reviewer.selection.kind === 'current' ? { ...reviewer, provider: profile.provider,
    modelId: profile.modelId, apiKey: profile.apiKey, baseUrl: profile.baseUrl } : reviewer;
}

export function needsTaskReviewer(profile: RuntimeProfile, reviewer: RuntimeReviewProfile): boolean {
  reviewer = resolveTaskReviewer(profile, reviewer);
  const current = profile.reviewer;
  return !current || reviewer.revision > current.revision
    || current.provider !== reviewer.provider || current.modelId !== reviewer.modelId
    || current.apiKey !== reviewer.apiKey || current.baseUrl !== reviewer.baseUrl
    || JSON.stringify(current.selection) !== JSON.stringify(reviewer.selection);
}

export function createTaskRiskEvaluator(taskId: string, budget: BudgetPort | undefined, assertActive: () => void,
  generation: () => string, profile: () => RuntimeProfile, history: () => string[],
  diagnostic?: (event: DiagnosticEvent) => void): AiRiskEvaluator {
  return new AiRiskEvaluator(() => {
    const current = profile(), reviewer = current.reviewer;
    return reviewer ? { provider: reviewer.provider, modelId: reviewer.modelId, apiKey: reviewer.apiKey,
      baseUrl: reviewer.baseUrl, kind: reviewer.selection.kind }
      : { provider: current.provider, modelId: current.modelId, apiKey: current.apiKey, baseUrl: current.baseUrl, kind: 'current' };
  }, createTaskReviewer(taskId, budget, assertActive, generation, {
    model: () => {
      const current = profile(), reviewer = current.reviewer;
      return reviewer ? { provider: reviewer.provider, modelId: reviewer.modelId }
        : { provider: current.provider, modelId: current.modelId };
    },
    diagnostic
  }), history);
}

export interface ReviewerObservationHooks {
  model?(): { provider: string; modelId: string };
  diagnostic?(event: DiagnosticEvent): void;
}

export function createTaskReviewer(taskId: string, budget: BudgetPort | undefined, assertActive: () => void,
  generation: () => string, hooks?: ReviewerObservationHooks): ReviewClient {
  const versions = new WeakMap<ProposedOperation, string>();
  const requests = new WeakMap<ProposedOperation, { logicalRequestId: string; attempt: number; transport: string; started: number }>();
  const check = (operation: ProposedOperation) => {
    assertActive();
    if (versions.get(operation) !== generation()) throw new Error('审核策略已变化，已停止请求重试。');
  };
  const client = new PiReviewClient(async (operation, attempt, signal) => {
    check(operation); signal?.throwIfAborted();
    if (!budget || operation.scope.taskId !== taskId) throw new Error('Reviewer budget authorization unavailable');
    const result = await budget({ kind: 'review', taskId, operationId: operation.id, attempt }, signal);
    check(operation); signal?.throwIfAborted();
    if (result.kind !== 'review' || result.scopeId !== operation.id) throw new Error('Reviewer budget binding changed');
    const previous = requests.get(operation);
    requests.set(operation, { logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt,
      transport: attempt.transport, started: previous?.started ?? Date.now() });
    const model = hooks?.model?.();
    hooks?.diagnostic?.({ event: 'model.request', taskId, operationId: operation.id, purpose: attempt.purpose,
      logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt, transport: attempt.transport,
      request: result.used, provider: model?.provider, model: model?.modelId });
  });
  const respond = (operation: ProposedOperation, status: string) => {
    const request = requests.get(operation);
    if (!request) return;
    hooks?.diagnostic?.({ event: 'model.response', taskId, operationId: operation.id, purpose: 'review',
      logicalRequestId: request.logicalRequestId, attempt: request.attempt, transport: request.transport,
      status, responseAttributed: true, durationMs: Date.now() - request.started });
  };
  const observe = (operation: ProposedOperation, signal: AbortSignal | undefined,
    run: () => Promise<RiskAssessment | RiskAssessment['verdict']>) => {
    versions.set(operation, generation());
    requests.delete(operation);
    return run().then((result) => {
      respond(operation, typeof result === 'string' ? result : result.verdict);
      return result;
    }, (error: unknown) => {
      respond(operation, signal?.aborted ? 'aborted' : 'error');
      throw error;
    });
  };
  return {
    jev: (operation, analysis, key, history, context, signal) =>
      observe(operation, signal, () => client.jev(operation, analysis, key, history, context, signal)),
    ordinary: (operation, analysis, profile, history, context, signal) =>
      observe(operation, signal, () => client.ordinary(operation, analysis, profile, history, context, signal))
  };
}
