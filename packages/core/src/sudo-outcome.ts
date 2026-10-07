import type { CommandAnalysis, OperationResult } from './model.js';
import { isSudo, sudoTarget } from './sudo-plan.js';

/** Diagnostic-only forms that cannot validate another isolated command's sudo timestamp. */
export function isSudoStatusProbe(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]!.call;
  return isSudo(call) && call.args.length > 0
    && call.args.every((arg) => ['-n', '--non-interactive', '-l', '--list', '-v', '--validate'].includes(arg))
    && call.args.some((arg) => ['-l', '--list', '-v', '--validate'].includes(arg));
}

/** Exit status wins over earlier retries. Never infer payload effects from arbitrary output. */
export function describeSudoOutcome(analysis: CommandAnalysis, result: OperationResult, attempts: number): OperationResult {
  const call = analysis.steps?.length === 1 ? analysis.steps[0]?.call : undefined;
  if (!analysis.calls.some(isSudo)) return result;
  if (call && isSudo(call) && result.status === 'succeeded' && result.exitCode === 0) return { ...result, authentication: 'succeeded', authenticationAttempts: attempts };
  if (result.status !== 'failed') return result;
  const target = call && isSudo(call) ? sudoTarget(call) : undefined;
  const options = call && target ? call.args.slice(0, call.args.length - target.args.length - 1) : [];
  if (options.some((arg) => ['-n', '--non-interactive'].includes(arg))
    && /(?:^|[\r\n])sudo:\s*a password is required\s*(?:$|[\r\n])/iu.test(result.stdoutTail)) {
    return { ...result, authentication: 'required', failureKind: 'authentication-required', effects: 'none', requiresUserAction: false };
  }
  if (/(?:^|[\r\n])sudo:\s*(?:\d+ incorrect password attempt|authentication (?:failure|failed)|PAM authentication error|a password is required|no password was provided|.*not allowed to execute|.*not in the sudoers|.*may not run sudo)/iu.test(result.stdoutTail)) {
    return { ...result, authentication: 'failed', authenticationAttempts: attempts,
      failureKind: 'authentication-failed', requiresUserAction: true };
  }
  return result;
}
