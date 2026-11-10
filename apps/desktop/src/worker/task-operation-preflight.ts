import { isReadOnlyQuery, isSudoStatusProbe, operationIntentKey, sudoTarget, type CommandAnalyzer, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { inputPlan } from './operation-input-plan.js';
import { blockedOperationFeedback } from './operation-feedback.js';

type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;
/** Resolve identity and reject replay/unsupported authentication before review.
 * This is not authorization: every admitted operation must still pass SafetyGate. */
export async function taskOperationPreflight(operation: ProposedOperation, deps: {
  privileged?: PrivilegedTaskAccess;
  analyzer: CommandAnalyzer;
  operations(): readonly OperationView[];
  replayProtected: ReadonlySet<string>;
}, manualReview = false): Promise<{ operation: ProposedOperation } | Feedback> {
    if (operation.kind !== 'command' || !operation.processControl) operation = await deps.privileged?.prepare?.(operation) ?? operation;
    if (operation.kind === 'command' && !operation.scope.sessionId) {
      // Identity is derived before fingerprinting, never by the renderer or after approval.
      const analysis = await deps.analyzer.analyze(operation.command).catch(() => undefined);
      if (analysis?.steps?.length === 1) {
        const target = sudoTarget(analysis.steps[0]!.call);
        if (target) operation.scope.runAs = target.runAs;
      }
    }
    const analysis = operation.kind === 'command' ? await deps.analyzer.analyze(operation.command).catch(() => undefined) : undefined;
    if (!analysis || !isReadOnlyQuery(analysis)) {
      const key = operationIntentKey(operation);
      const denied = !manualReview && deps.operations().find((item) =>
        item.intentKey === key && item.status === 'denied' && item.ruleId === 'ai-review-deny');
      if (denied) return blockedOperationFeedback(operation.id, 'prior-review-denied',
        `Not executed; effects: none. Independent AI review already denied the same operation (${denied.id}). Do not retry it under a new ID or wrapper. Propose a substantively safer action or let the user request exact manual review.`, denied.id);
      const previous = deps.operations().find((item) => item.intentKey === key
        && (['running', 'proposed', 'approved', 'unknown'].includes(item.status) || (item.status === 'succeeded' && deps.replayProtected.has(item.id))));
      if (previous) return blockedOperationFeedback(operation.id, 'replay-protected', `Not executed: operation ${previous.id} already records this action (${previous.status}). Read its log and inspect the actual result; do not replay it. A new operation ID does not make a retry safe.`, previous.id);
    }
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
