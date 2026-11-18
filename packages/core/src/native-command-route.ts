import path from 'node:path';
import { hasCodeExecution } from './command-code-execution.js';
import { isSudo, sudoTarget, supportsSudo } from './sudo-plan.js';
import type { CommandAnalysis, ProposedOperation } from './model.js';

/** Stage-one transport eligibility, not a safety verdict. Only a single,
 * literal, non-privileged foreground command may use native SSH exec. */
export function nativeCommandEligible(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  if (operation.kind !== 'command' || operation.executionMode || operation.processControl || operation.privilege === 'root'
    || operation.scope.sessionId || analysis.hasError || analysis.hasCompound || analysis.hasExpansion
    || analysis.hasPipeline || analysis.hasRedirection || analysis.calls.length !== 1 || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]?.call;
  // Wrapper commands can hide authentication or a detached child behind one
  // syntactic call. Defer them until the foreground/privilege planner can inspect
  // the actual recipient; never route an `env sudo ...` through ordinary stdin.
  const wrappers = ['sudo', 'su', 'doas', 'pkexec', 'runuser', 'env', 'busybox', 'nice', 'nohup', 'setsid', 'timeout'];
  return !!call && !call.dynamic && !analysis.calls[0]?.dynamic
    && call.name === analysis.calls[0]?.name && JSON.stringify(call.args) === JSON.stringify(analysis.calls[0]?.args)
    && !wrappers.includes(path.posix.basename(call.name)) && !hasCodeExecution(call);
}

/** Stage-one transport eligibility for one literal sudo command served by the
 * credential-bound native PTY. Not a safety verdict and never an authorization.
 * Model-supplied prompt/askpass selectors would override the client marker or
 * move the password to an uncontrolled helper, and a nested sudo/su under this
 * sudo would prompt with its own unmarked prompt, so such forms stay off. */
export function nativePtySudoEligible(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  if (operation.kind !== 'command' || operation.executionMode || operation.processControl
    || operation.scope.sessionId || analysis.hasError || analysis.hasExpansion
    || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]!.call;
  // The analyzer marks the wrapped sudo command itself as compound; one literal
  // sudo step is exactly the form this channel serves, mirroring sudoContextCommand.
  if (analysis.hasCompound && !isSudo(call)) return false;
  const target = isSudo(call) ? sudoTarget(call) : undefined;
  return !!target && !call.dynamic && !call.redirects
    && !/(?:^|\/)(?:sudo|su)$/u.test(target.name) && supportsSudo(analysis)
    && !call.args.some((arg) => ['-p', '--prompt', '-A', '--askpass'].includes(arg));
}
