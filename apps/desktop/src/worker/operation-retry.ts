import type { ExecutionOptions, ProposedOperation, SafetyDecision } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { taskOperationPreflight, type TaskOperationPreflightDeps } from './task-operation-preflight.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { dispatchNeverReached, retrySafeReadonly, withReadOnlyRetry } from './retry-policy.js';

type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;

/** One gate execution attempt, or already-rendered final feedback when the
 * attempt was refused before dispatch (preflight, review, approval). */
export type OperationAttempt = { feedback: Feedback } | { operation: ProposedOperation; outcome: Awaited<ReturnType<SafetyGate['execute']>> };

/** Gate observer selection mirrors SafetyGate.execute's own parameter shape. */
export interface GateObserver {
  onProcessStarted?: ExecutionOptions['onProcessStarted'];
  onFileInspection?: ExecutionOptions['onFileInspection'];
}

export interface OperationPipelineContext {
  gate: SafetyGate;
  signal?: AbortSignal;
  manualReview: boolean;
  preflight: TaskOperationPreflightDeps;
  gateObserver(operation: ProposedOperation): GateObserver;
  coordinateDecision(decision: SafetyDecision): void;
  onRetry(previousOperationId: string, nextAttempt: number): void;
}

/** performOperation's dispatch pipeline inside the bounded read-only retry loop:
 * every attempt re-runs preflight → SafetyGate under a fresh operation ID, so
 * approval and fingerprint bindings never carry over between attempts. */
export async function runOperationPipeline(context: OperationPipelineContext, operation: ProposedOperation): Promise<OperationAttempt> {
  return withReadOnlyRetry<OperationAttempt>({
    operation, signal: context.signal,
    classifyRetrySafe: (candidate) => retrySafeReadonly(candidate, context.preflight.analyzer),
    retryableOutcome: (value) => 'outcome' in value && value.outcome.result && dispatchNeverReached(value.outcome.result) ? value.outcome.result : undefined,
    attempt: (candidate) => attemptOperation(context, candidate),
    onRetry: context.onRetry
  });
}

async function attemptOperation(context: OperationPipelineContext, operation: ProposedOperation): Promise<OperationAttempt> {
  const prepared = await taskOperationPreflight(operation, context.preflight, context.manualReview);
  if (!('operation' in prepared)) return { feedback: prepared };
  operation = prepared.operation;
  const outcome = await context.gate.execute(operation, context.signal, context.manualReview, context.gateObserver(operation));
  context.coordinateDecision(outcome.decision);
  if (!outcome.result) return { feedback: blockedOperationFeedback(operation.id, outcome.decision.ruleId,
    `Executed: false; effects: none. SafetyGate ${outcome.decision.verdict} (${outcome.decision.ruleId}): ${outcome.decision.reason}`, undefined, outcome.readOnly) };
  return { operation, outcome };
}
