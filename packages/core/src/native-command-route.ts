import path from 'node:path';
import { isPackagerTransaction } from './command-code-execution.js';
import { isSudo, sudoOwnOptions, sudoTarget, supportsSudo } from './sudo-plan.js';
import { isSu } from './su-plan.js';
import type { CommandAnalysis, ProposedOperation } from './model.js';

/** Wrapper commands can hide authentication or a detached child behind one
 * syntactic call. They never qualify for a native channel: the foreground
 * planner must inspect the actual recipient, and never route an `env sudo ...`
 * through ordinary stdin or a detached launch. */
const wrappers = ['sudo', 'su', 'doas', 'pkexec', 'runuser', 'env', 'busybox', 'nice', 'nohup', 'setsid', 'timeout'];

/** Stage-one transport eligibility, not a safety verdict. Foreground native SSH
 * exec serves every command form whose calls the reviewer can still analyze
 * one by one: compound lists, pipelines and redirections of literal arguments
 * stay reviewable here, as do interpreter invocations (conservative write
 * review, never auto-approved). Expansions and opaque syntax (unknowable
 * argument text), wrappers (hidden authentication or detached children),
 * packager transactions (maintainer scripts), detached `&` launches and
 * session-bound forms stay off — those have their own channel or are refused.
 * `privilege=root` operations reach preflight only after the privilege planner
 * rewrote them (sudo/su wrap) or proved the login identity is already root, so
 * the route itself does not exclude the marker; the wrapped forms are caught
 * by the wrapper check below. */
export function nativeCommandEligible(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  if (operation.kind !== 'command' || operation.executionMode || operation.processControl
    || operation.scope.sessionId || analysis.hasError || analysis.hasExpansion || analysis.calls.length === 0) return false;
  // Steps prove a literal compound list, hasPipeline a literal pipeline and
  // hasRedirection a literal redirect; without any of them the text is opaque
  // or a detached launch and has no per-call proof for this channel.
  if (analysis.steps === undefined && !analysis.hasPipeline && !analysis.hasRedirection) return false;
  return analysis.calls.every((call) => !call.dynamic && !wrappers.includes(path.posix.basename(call.name))
    && !isPackagerTransaction(call));
}

/** Stage-one transport eligibility for the backend-rendered detached background
 * launch. Only a single literal, non-privileged background command may use the
 * native background channel: the reviewed text is embedded once into a
 * backend-built setsid launch, and stop stays bound to the exact process group
 * created by that launch. Wrapper commands stay off because they can hide a
 * second session or defeat the group bound; packager transactions run
 * maintainer scripts and keep their interactive stdin channel instead.
 * Interpreter and code-execution commands are reviewed as writes like their
 * foreground counterparts. Not a safety verdict. */
export function nativeBackgroundEligible(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  if (operation.kind !== 'command' || operation.executionMode !== 'background' || operation.processControl
    || operation.privilege === 'root' || operation.scope.sessionId || analysis.hasError || analysis.hasCompound
    || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection
    || analysis.calls.length !== 1 || analysis.steps?.length !== 1) return false;
  const call = analysis.steps[0]!.call;
  return !!call && !call.dynamic && !analysis.calls[0]!.dynamic
    && call.name === analysis.calls[0]!.name && JSON.stringify(call.args) === JSON.stringify(analysis.calls[0]!.args)
    && !wrappers.includes(path.posix.basename(call.name)) && !isPackagerTransaction(call);
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
    && !sudoOwnOptions(call).some((arg) => ['-p', '--prompt', '-A', '--askpass'].includes(arg))
    && !/(?:^|\/)(?:sudo|su)$/u.test(target.name) && supportsSudo(analysis);
}

/** Stage-one transport eligibility for the backend-built operation-level su wrap
 * served by the credential-bound native PTY. Only privilege=root commands the
 * backend itself wrapped take this route: agent-supplied sudo/su forms are
 * refused before preflight (nested privilege), and a plain su without the
 * backend privilege marker never qualifies. The analyzer flattens the wrap —
 * the escaped single-quoted -c body is a concatenation, so the su call reads
 * dynamic and literal steps stay undefined — so the route matches the collected
 * su call plus the backend body shape instead. Not a safety verdict. */
export function nativePtySuEligible(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  if (operation.kind !== 'command' || operation.privilege !== 'root' || operation.executionMode
    || operation.processControl || operation.scope.sessionId || analysis.hasError || analysis.hasExpansion
    || analysis.hasPipeline || analysis.hasRedirection) return false;
  const call = analysis.calls[0];
  if (!call || !isSu(call) || call.redirects || call.args.length !== 6) return false;
  const [login, shellFlag, shellPath, user, commandFlag, body] = call.args;
  // The suPtyCommand body always embeds the quoted working directory guard before
  // the reviewed action; a bare -c payload is an agent form, not this route.
  return login === '-l' && shellFlag === '-s' && shellPath === '/bin/sh'
    && user === 'root' && commandFlag === '-c' && typeof body === 'string'
    && /^cd '.*' \|\| exit 125\n[\s\S]+$/u.test(body);
}
