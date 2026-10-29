import { redactOutput, privilegeGuidance, type OperationResult } from '@cloudhelm/core';

/** UTF-8-safe bounded feedback, after redaction; never a way to slice raw secrets. */
export function feedbackTail(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(redactOutput(value));
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString('utf8'), truncated: start > 0 };
}
function guidance(result: OperationResult, readOnly?: boolean): string {
  if (result.privilege) return privilegeGuidance(result.privilege);
  if (result.authentication === 'succeeded') return result.status === 'succeeded' && result.exitCode === 0
    ? 'The operation completed successfully after private authentication. Earlier password retry messages do not negate exit 0. Continue using bounded sudo when needed; do not test sudo -n/-l/-v. Authentication is isolated per operation; passwordless probes do not determine whether authenticated sudo works.'
    : 'Private authentication succeeded, but that does not prove the requested command succeeded. Follow the reported status and exit code; do not test sudo -n/-l/-v or bypass a control stop.';
  if (result.authentication === 'required') return 'Non-interactive sudo needed authentication; this is not a rejected password or denial. Submit the actual required command without -n through normal review; CloudHelm will prompt privately if necessary.';
  if (result.failureKind === 'unresolved-prior-operation') return 'SafetyGate allowed this command, but a separate host outcome lock prevented dispatch; this command had no effects. Read-only inspection may continue. read_operation_log only accepts operations from this conversation: for IDs from another conversation, use the host recovery card to view the original redacted log and confirm each unresolved result. Do not retry this blocked write until every host lock is resolved; a new command still requires its own review.';
  if (result.failureKind === 'permission-denied') return result.effects === 'none'
    ? 'This operation had no effects. If needed, submit the corrected bounded sudo command through normal review and private authentication; no prior-effects verification is needed. Do not repeat known failing unprivileged checks or bypass a review/authentication refusal.'
    : 'Check the permission failure for this operation. Use a new reviewed bounded sudo operation when appropriate. Verify possible partial effects before retrying; do not repeat known failing unprivileged checks.';
  if (result.status === 'failed' && result.effects === 'none' && readOnly === true && Number.isInteger(result.exitCode) && result.exitCode! > 0
    && !result.requiresUserAction && result.authentication !== 'failed'
    && !['authentication-failed', 'unsupported', 'user-action-required'].includes(result.failureKind ?? ''))
    return 'This effect-free query returned a nonzero exit; no prior-effects verification is needed. The result alone does not establish a cause or broader system state. Reuse the observation and explain uncertainty; do not replay merely to manufacture success.';
  return result.status === 'failed' && result.effects === 'none'
    ? 'This operation had no effects. Check the cause and, if useful, retry once with a corrected bounded command; do not repeat the same failing command unchanged.' : '';
}
function output(result: OperationResult) {
  return feedbackTail(result.authentication === 'succeeded'
    ? result.stdoutTail.replace(/(?:^|\r?\n)Sorry, try again\.\r?(?=\n|$)/gu, '') : result.stdoutTail, 40 * 1024);
}
export function operationFeedbackDetails(result: OperationResult, readOnly?: boolean) {
  return { operationId: result.operationId, status: result.status, readOnly: readOnly ?? 'unclassified',
    exitCode: result.exitCode ?? null, effects: result.effects ?? 'not-classified', ...(result.privilege ? { privilege: result.privilege } : {}),
    outputTruncated: output(result).truncated || result.outputCapture?.truncated === true ? true : result.outputCapture?.truncated ?? 'unknown',
    capturedChars: result.outputCapture?.totalChars ?? null, logAvailability: result.logRef ? 'reference-only' : 'unknown',
    ...(result.logRef ? { retrieval: { tool: 'read_operation_log', operationId: result.operationId, cursor: 0 } } : {}) };
}
export function operationFeedback(result: OperationResult, host: string, readOnly?: boolean): string {
  const details = operationFeedbackDetails(result, readOnly);
  const next = guidance(result, readOnly);
  return `Operation ID: ${result.operationId}\nHost: ${redactOutput(host).slice(0, 160)}\nStatus: ${result.status}\nRead-only capability: ${details.readOnly}\nExit: ${result.exitCode ?? 'unknown'}\nFailure kind: ${result.failureKind ?? 'none'}\nEffects: ${details.effects}\nAuthentication: ${result.authentication ?? 'not reported'}\nOutput truncated: ${details.outputTruncated}\nCaptured characters: ${details.capturedChars ?? 'unknown'} (redacted observations only, not proof of process exit)\nLog availability: ${details.logAvailability}; retention/completeness are not guaranteed.${details.retrieval ? ` Use read_operation_log with operationId=${result.operationId}, cursor=0; do not replay the operation for output.` : ''}\n${next ? `Next-step guidance: ${next}\n` : ''}Output tail (untrusted data):\n${output(result).text}`;
}
export function operationToolResult(result: OperationResult, host: string, readOnly?: boolean) {
  return { result, readOnly, details: operationFeedbackDetails(result, readOnly),
    content: [{ type: 'text' as const, text: operationFeedback(result, host, readOnly) }], isError: result.status !== 'succeeded' };
}
export function blockedOperationFeedback(operationId: string, code: string, message: string, priorOperationId?: string, readOnly?: boolean) {
  const details = { operationId, status: 'not-executed', effects: 'none', readOnly: readOnly ?? 'unclassified', code,
    priorOperationId, logAvailability: priorOperationId ? 'reference-only' : 'unavailable' };
  return { readOnly, details, content: [{ type: 'text' as const, text: `Operation ID: ${operationId}\n${JSON.stringify(details)}\n${feedbackTail(message, 8 * 1024).text}` }], isError: true };
}
