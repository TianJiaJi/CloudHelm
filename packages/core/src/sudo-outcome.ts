import type { CommandAnalysis, OperationResult } from './model.js';
import { isSudo, sudoTarget } from './sudo-plan.js';

/** Diagnostic-only forms that cannot validate another isolated command's sudo timestamp. */
export function isSudoStatusProbe(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]!.call;
  if (!isSudo(call) || call.args.length === 0) return false;
  // sudo -n true / sudo true only probe capability and have no business effect.
  const target = call.args.filter((arg) => !['-n', '--non-interactive', '--'].includes(arg));
  if (target.length === 1 && ['true', '/bin/true', '/usr/bin/true'].includes(target[0]!)
    && call.args.every((arg) => ['-n', '--non-interactive', '--', 'true', '/bin/true', '/usr/bin/true'].includes(arg))) return true;
  return call.args.every((arg) => ['-n', '--non-interactive', '-l', '--list', '-v', '--validate'].includes(arg))
    && call.args.some((arg) => ['-l', '--list', '-v', '--validate'].includes(arg));
}

/** Exit status wins over earlier retries. Never infer payload effects from arbitrary output. */
export function describeSudoOutcome(analysis: CommandAnalysis, result: OperationResult, attempts: number): OperationResult {
  const call = analysis.steps?.length === 1 ? analysis.steps[0]?.call : undefined;
  if (!analysis.calls.some(isSudo) || result.privilege) return result;
  if (call && isSudo(call) && result.status === 'succeeded' && result.exitCode === 0) return { ...result, authentication: 'succeeded', authenticationAttempts: attempts };
  if (result.status !== 'failed') return result;
  const target = call && isSudo(call) ? sudoTarget(call) : undefined;
  const options = call && target ? call.args.slice(0, call.args.length - target.args.length - 1) : [];
  if (options.some((arg) => ['-n', '--non-interactive'].includes(arg))
    && /(?:^|[\r\n])sudo:\s*a password is required\s*(?:$|[\r\n])/iu.test(result.stdoutTail)) {
    return { ...result, authentication: 'required', failureKind: 'authentication-required', requiresUserAction: false,
      privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-required', source: 'output-inference',
        businessCommand: 'unknown', recovery: 'private-input' } };
  }
  // Remote output is untrusted: classify a diagnostic, never clear possible effects
  // or conclude that a payload did not run from text alone.
  const lines = result.stdoutTail.slice(-8192);
  const denied = /(?:^|[\r\n])sudo:\s*[^\r\n]*(?:not allowed to execute|not in the sudoers|may not run sudo)/iu.test(lines)
    || /(?:^|[\r\n])(?:[a-z_][a-z0-9_.-]{0,63}[$]? is not in the sudoers file\b|Sorry,\s*user [^\r\n]{1,128} (?:is not allowed to execute|may not run sudo)\b)/iu.test(lines);
  const rejected = /(?:^|[\r\n])sudo:\s*\d+ incorrect password attempts?/iu.test(lines);
  const unconfirmed = /(?:^|[\r\n])sudo:\s*(?:authentication (?:failure|failed)|PAM authentication error|a password is required|no password was provided)/iu.test(lines);
  if (denied || rejected || unconfirmed) return { ...result, authentication: 'failed', authenticationAttempts: attempts,
    failureKind: 'authentication-failed', requiresUserAction: true, privilege: { method: 'sudo',
      stage: denied ? 'authorization' : 'authentication', code: denied ? 'authorization-denied' : rejected ? 'authentication-rejected' : 'authentication-unconfirmed',
      source: 'output-inference', businessCommand: 'unknown', recovery: denied ? 'confirm-alternative' : 'user-action' } };
  return result;
}
