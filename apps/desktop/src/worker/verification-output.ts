import type { GoalCheck, OperationView, VerificationSubmissionV3 } from '@cloudhelm/contracts';
import { hasJournalCredentials } from './journal-secrets.js';

/** Only structured no-dispatch evidence, never a nonzero exit or arbitrary output alone. */
export function confirmedNotStarted(operation: OperationView): boolean {
  return operation.status === 'failed' && operation.effects === 'none'
    && (operation.privilege?.source === 'transport' && operation.privilege.businessCommand === 'not-started'
      || operation.failureKind === 'unsupported' && operation.exitCode === 127);
}

export function completeOutput(operation: OperationView): string | undefined {
  const capture = operation.outputCapture;
  if (confirmedNotStarted(operation) || typeof operation.outputTail !== 'string' || !operation.exitObserved || operation.reconciliation?.kind === 'evidence' || !Number.isInteger(operation.exitCode)
    || !['succeeded', 'failed'].includes(operation.status) || !capture || capture.truncated
    || capture.totalChars !== operation.outputTail?.length || capture.tailChars !== capture.totalChars) return;
  if (hasJournalCredentials(operation.outputTail) || /\[REDACTED[^\]]*\]/iu.test(operation.outputTail)) return;
  return operation.outputTail;
}
export const normalize = (text: string) => text.replace(/\r\n/gu, '\n');

/** Match only the actual captured run. A proposed expectation is not proof it matches the user's whole goal. */
export function evaluateRunOutput(operation: OperationView, check: Extract<NonNullable<VerificationSubmissionV3['checks']>[number], { kind: 'run-output' }>): GoalCheck {
  const output = completeOutput(operation);
  const exited = !confirmedNotStarted(operation) && operation.exitObserved && ['succeeded', 'failed'].includes(operation.status) && Number.isInteger(operation.exitCode)
    && operation.reconciliation?.kind !== 'evidence';
  const wrongExit = exited && operation.exitCode !== (check.expectedExitCode ?? 0);
  return { kind: 'run-output', authority: 'deterministic', expectationSource: 'report', target: `本次运行输出 · ${operation.id}`, operationIds: [operation.id],
    expected: `退出码 ${check.expectedExitCode ?? 0}；完整输出：\n${check.expectedOutput}`,
    observed: output === undefined ? `退出码：${exited ? operation.exitCode : '未知'}；输出捕获不完整或未确认，不能比较完整输出。`
      : `退出码 ${operation.exitCode}；实际完整输出：\n${output.slice(0, 16384)}`,
    status: wrongExit ? 'failed' : output === undefined ? 'inconclusive'
      : normalize(output) === normalize(check.expectedOutput) ? 'passed' : 'failed' };
}
