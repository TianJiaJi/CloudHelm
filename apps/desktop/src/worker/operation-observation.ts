import { redactOutput, type OperationResult } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';

/** One projection for both synchronous results and late transport completions.
 * Model/session lifecycle and summaries never supply these fields. */
export function applyOperationObservation(operation: OperationView, result: OperationResult): void {
  // Tool interruption can settle after its transport already reported an actual exit.
  // Preserve that observation; a late aborted await is not evidence the process revived.
  if (operation.exitObserved && ['unknown', 'handed-over'].includes(result.status)) {
    if (result.privilege) operation.privilege = result.privilege;
    if (result.authentication) operation.authentication = result.authentication;
    return;
  }
  const pendingStop = !!result.remoteCompletion && ['unknown', 'handed-over'].includes(result.status)
    && operation.executionJob?.status === 'stop-requested';
  operation.status = pendingStop ? 'running' : result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown';
  if (result.processControl) operation.processControl = { ...operation.processControl, ...result.processControl };
  operation.exitCode = result.exitCode;
  operation.exitObserved = ['succeeded', 'failed'].includes(result.status) && Number.isInteger(result.exitCode);
  operation.completedAt = operation.exitObserved ? operation.completedAt ?? Date.now() : undefined;
  operation.authentication = result.authentication; operation.authenticationAttempts = result.authenticationAttempts;
  operation.failureKind = result.failureKind; operation.effects = result.effects; operation.privilege = result.privilege;
  operation.outputTail = redactOutput(result.stdoutTail);
  operation.outputCapture = result.outputCapture;
  operation.logRef = result.logRef;
}
