import { redactOutput, type OperationResult } from '@cloudhelm/core';

export function operationFeedback(result: OperationResult, host: string): string {
  const guidance = result.authentication === 'succeeded'
    ? 'The sudo operation completed successfully. Earlier password retry messages do not negate exit 0. Continue the task using bounded sudo when needed; do not test sudo -n/-l/-v. Each operation has an isolated authentication channel, so passwordless probes do not determine whether authenticated sudo works.'
    : result.authentication === 'required'
      ? 'Non-interactive sudo needed authentication; this is not a rejected password or denial. Submit the actual required command without -n through normal review; CloudHelm will prompt privately if necessary.'
      : result.failureKind === 'unresolved-prior-operation'
        ? 'This command was not sent and had no effects. A previous remote operation still needs verification. Read-only inspection may continue. Identify and reconcile the original operation before any write; do not retry this blocked write to bypass the guard.'
      : result.failureKind === 'permission-denied'
        ? 'Check the permission failure for this operation. Use a new reviewed bounded sudo operation when appropriate. Verify possible partial effects before retrying; do not repeat known failing unprivileged checks.'
        : result.status === 'failed' && result.effects === 'none'
          ? 'This operation had no effects. Check the cause and, if useful, retry once with a corrected bounded command; do not repeat the same failing command unchanged.' : '';
  const output = result.authentication === 'succeeded'
    ? result.stdoutTail.replace(/(?:^|\r?\n)Sorry, try again\.\r?(?=\n|$)/gu, '') : result.stdoutTail;
  return `Operation ID: ${result.operationId}\nHost: ${host}\nStatus: ${result.status}\nExit: ${result.exitCode ?? 'unknown'}\nFailure kind: ${result.failureKind ?? 'none'}\nEffects: ${result.effects ?? (result.status === 'succeeded' ? 'completed' : 'possible')}\nAuthentication: ${result.authentication ?? 'not reported'}\n${guidance ? `Next-step guidance: ${guidance}\n` : ''}Output tail:\n${redactOutput(output)}`;
}
