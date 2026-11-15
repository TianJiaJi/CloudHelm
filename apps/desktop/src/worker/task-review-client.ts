import { AiRiskEvaluator, PiReviewClient, type ReviewClient } from '@cloudhelm/adapters';
import type { ProposedOperation } from '@cloudhelm/core';
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
  generation: () => string, profile: () => RuntimeProfile, history: () => string[]): AiRiskEvaluator {
  return new AiRiskEvaluator(() => {
    const current = profile(), reviewer = current.reviewer;
    return reviewer ? { provider: reviewer.provider, modelId: reviewer.modelId, apiKey: reviewer.apiKey,
      baseUrl: reviewer.baseUrl, kind: reviewer.selection.kind }
      : { provider: current.provider, modelId: current.modelId, apiKey: current.apiKey, baseUrl: current.baseUrl, kind: 'current' };
  }, createTaskReviewer(taskId, budget, assertActive, generation), history);
}

export function createTaskReviewer(taskId: string, budget: BudgetPort | undefined, assertActive: () => void,
  generation: () => string): ReviewClient {
  const versions = new WeakMap<ProposedOperation, string>();
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
  });
  return {
    jev: (operation, ...args) => { versions.set(operation, generation()); return client.jev(operation, ...args); },
    ordinary: (operation, ...args) => { versions.set(operation, generation()); return client.ordinary(operation, ...args); }
  };
}
