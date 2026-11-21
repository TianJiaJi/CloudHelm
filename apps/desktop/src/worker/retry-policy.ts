import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { analyzeOperationImpact, type CommandAnalyzer, type OperationResult, type ProposedOperation } from '@cloudhelm/core';

/** Transient matrix, category ① (P0-1): the transport proved this command was never
 * dispatched, so the remote is definitively not running it and a fresh attempt cannot
 * double-apply anything. Everything else — in-flight timeouts, channel drops, thrown
 * transport errors — is category ② (remote may still be executing) and is never
 * auto-retried, even for reads. Default remains not retryable (fail-closed). */
export function dispatchNeverReached(result: OperationResult): boolean {
  return result.status === 'failed' && result.failureKind === 'not-dispatched'
    && result.effects === 'none' && result.requiresUserAction !== true;
}

/** Pure pre-classification for retry eligibility: only an analyzer-confirmed
 * effect-free foreground command may enter the retry loop. Writes, process control,
 * background launches and analysis failures stay outside it. */
export async function retrySafeReadonly(operation: ProposedOperation, analyzer: CommandAnalyzer): Promise<boolean> {
  if (operation.kind !== 'command' || operation.processControl || operation.executionMode === 'background') return false;
  try {
    return analyzeOperationImpact(operation, await analyzer.analyze(operation.command)).mutation === 'none';
  } catch { return false; }
}

export interface ReadOnlyRetryOptions<T> {
  operation: ProposedOperation;
  signal?: AbortSignal;
  /** Evaluated lazily, only on the first category-① failure before any retry. */
  classifyRetrySafe(operation: ProposedOperation): Promise<boolean>;
  /** Returns the attempt's result only when it is a category-① failure. */
  retryableOutcome(value: T): OperationResult | undefined;
  attempt(operation: ProposedOperation): Promise<T>;
  onRetry?(previousOperationId: string, nextAttempt: number): void;
  /** Test seam; production waits are abort-aware timer sleeps. */
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const BACKOFF_MS = [500, 1500];

/** One model call expands to at most one retry-extended attempt sequence: bounded to
 * 3 dispatches, each with a fresh operation ID and the full preflight → SafetyGate
 * pipeline (approval never carries over). The Pi engine's own replay stays disabled,
 * so the two retry layers never stack; writes never enter this loop. */
export async function withReadOnlyRetry<T>(options: ReadOnlyRetryOptions<T>): Promise<T> {
  let current = options.operation;
  for (let attemptNumber = 1; ; attemptNumber++) {
    const value = await options.attempt(current);
    const result = options.retryableOutcome(value);
    if (result === undefined || attemptNumber > BACKOFF_MS.length || options.signal?.aborted) return value;
    if (!(await options.classifyRetrySafe(current))) return value;
    current = { ...structuredClone(current), id: randomUUID() };
    options.onRetry?.(result.operationId, attemptNumber + 1);
    await (options.wait ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal })))(BACKOFF_MS[attemptNumber - 1]!, options.signal);
    if (options.signal?.aborted) return value;
  }
}
