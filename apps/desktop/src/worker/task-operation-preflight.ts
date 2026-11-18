import { analyzeOperationImpact, HOST_ENVIRONMENT_MAX_AGE_MS, isSudoStatusProbe, nativeCommandEligible, nativePtySudoEligible, operationIntentKey, sudoTarget,
  type CommandAnalyzer, type HostEnvironmentAccess, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { aptNeedsPtyStdin, inputPlan } from './operation-input-plan.js';
import { blockedOperationFeedback } from './operation-feedback.js';

type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;
/** Resolve identity and reject replay/unsupported authentication before review.
 * This is not authorization: every admitted operation must still pass SafetyGate. */
export async function taskOperationPreflight(operation: ProposedOperation, deps: {
  privileged?: PrivilegedTaskAccess;
  analyzer: CommandAnalyzer;
  environment?: HostEnvironmentAccess;
  operations(): readonly OperationView[];
  replayProtected: ReadonlySet<string>;
  /** Known dispatch blockers (unresolved host outcomes) discovered before review. */
  hostBlocked?(hostId: string): string | undefined;
}, manualReview = false): Promise<{ operation: ProposedOperation } | Feedback> {
    if (operation.kind !== 'command' || !operation.processControl) operation = await deps.privileged?.prepare?.(operation) ?? operation;
    // Transport selection is backend-owned; never accept a model/tool-supplied route.
    if (operation.kind === 'command') {
      const { executionChannel: _untrusted, ...rest } = operation;
      operation = rest;
    }
    if (operation.kind === 'command' && !operation.scope.sessionId) {
      // Identity is derived before fingerprinting, never by the renderer or after approval.
      const analysis = await deps.analyzer.analyze(operation.command).catch(() => undefined);
      if (analysis?.steps?.length === 1) {
        const target = sudoTarget(analysis.steps[0]!.call);
        if (target) operation.scope.runAs = target.runAs;
      }
    }
    const analysis = operation.kind === 'command' ? await deps.analyzer.analyze(operation.command).catch(() => undefined) : undefined;
    // Transport selection stays backend-owned and capability-driven: single literal
    // foreground commands run without Python, one literal sudo command gets the
    // credential-bound PTY, and apt transactions that must answer a prompt keep a
    // stdin-capable channel instead of the stdin-less native exec.
    if (analysis && operation.kind === 'command' && !aptNeedsPtyStdin(analysis) && nativeCommandEligible(operation, analysis))
      operation = { ...operation, executionChannel: 'native-exec' };
    else if (analysis && operation.kind === 'command' && nativePtySudoEligible(operation, analysis))
      operation = { ...operation, executionChannel: 'native-pty' };
    // Replay protection answers one question: could repeating this request re-apply
    // effects that were already dispatched? Effect-free queries use exactly the safety
    // gate's own classification, so a repeated observation (ss, ip, ping, literal reads)
    // is a new observation, not a replay of a change. A prior denial still binds its exact
    // intent, and unknown results or in-flight dispatches still block non-query requests.
    const readOnly = analyzeOperationImpact(operation, analysis).mutation === 'none';
    const key = operationIntentKey(operation);
    const denied = !manualReview && deps.operations().find((item) =>
      item.intentKey === key && item.status === 'denied' && item.ruleId === 'ai-review-deny');
    if (denied) return blockedOperationFeedback(operation.id, 'prior-review-denied',
      `Not executed; effects: none. Independent AI review already denied the same operation (${denied.id}). Do not retry it under a new ID or wrapper. Propose a substantively safer action or let the user request exact manual review.`, denied.id);
    if (!readOnly) {
      const previous = deps.operations().find((item) => item.intentKey === key
        && (['running', 'proposed', 'approved', 'unknown'].includes(item.status) || (item.status === 'succeeded' && deps.replayProtected.has(item.id))));
      if (previous) return blockedOperationFeedback(operation.id, 'replay-protected', `Not executed: operation ${previous.id} already records this action (${previous.status}). Read its log and inspect the actual result; do not replay it. A new operation ID does not make a retry safe.`, previous.id);
    }
    // Known-impossible dispatch is refused before an approval card or an AI review is
    // paid for; the serial executor still re-checks the same condition at dispatch.
    // A bound stop request is the remedy for a running operation, never a new write;
    // blocking it because that operation is running would make it unstoppable.
    if (!readOnly && !(operation.kind === 'command' && operation.processControl)) {
      const blocker = deps.hostBlocked?.(operation.scope.hostId);
      if (blocker) return blockedOperationFeedback(operation.id, 'unresolved-prior-operation',
        `Not executed; effects: none. ${blocker} Read-only inspection may continue; a new write needs its own review after the original outcome is verified.`);
    }
    // A current connected-host observation can rule out an explicit PATH Python command.
    // Missing/stale facts are not permission grants or evidence that Python is present.
    const observed = deps.environment?.snapshot(operation.scope.hostId, operation.scope.loginAs ?? operation.scope.runAs);
    const pythonAbsent = observed?.status === 'observed' && observed.connectionId
      && observed.observedAt !== null && !observed.presenceStale
      && Date.now() >= observed.observedAt && Date.now() - observed.observedAt <= HOST_ENVIRONMENT_MAX_AGE_MS
      && observed.data?.toolPresence.python3 === false;
    if (pythonAbsent && operation.kind === 'command' && analysis
      && analysis.calls.some((call) => call.name === 'python3' && !call.dynamic))
      return blockedOperationFeedback(operation.id, 'capability-blocked',
        'No command sent; effects: none. Current host facts report no python3 on the fixed execution PATH. Use an appropriate Shell command or prepare Python through an independently reviewed and authorized operation; do not retry the same unsupported command.');
    if (pythonAbsent && !operation.scope.sessionId && (operation.kind === 'command' && operation.executionMode === 'background'
      || ['write-file', 'inspect-file', 'list-recovery', 'cleanup-recovery'].includes(operation.kind)))
      return blockedOperationFeedback(operation.id, 'capability-blocked',
        'No operation sent; effects: none. This supervised background or strict file transaction still needs the legacy remote Python driver. The plain native SSH path cannot safely replace its process or metadata guarantees yet; do not bypass with ordinary Shell writes or stops.');
    // Refuse sudo capability probes before review: they deserve no approval card and no pause.
    if (analysis && isSudoStatusProbe(analysis)) return blockedOperationFeedback(operation.id, 'unsupported-probe',
      'No command sent; effects: none. sudo 状态/权限探测（sudo -n true、sudo -l、sudo -v 等）不被支持，也不能证明下一条 sudo 命令可用。请直接提交实际的有界 sudo 命令，私有认证通道会在需要时提示输入。');
    // The authentication bridge cannot execute these forms. Refuse them before showing
    // an approval card; an approval cannot make an unsupported transport safe to run.
    if (analysis && operation.kind === 'command' && !operation.scope.sessionId && !inputPlan(analysis)
      && analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name))) return blockedOperationFeedback(operation.id, 'unsupported-authentication-form',
        'No command sent; effects: none. This sudo/su command form is unsupported by the private authentication channel (including sudo pipelines and redirections). Do not wrap or switch tools to bypass this limit. Submit the actual bounded sudo operation as one reviewed command, or explain that manual handling is required.');

  return { operation };
}
