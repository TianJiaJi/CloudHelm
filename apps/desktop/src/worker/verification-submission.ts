import { Value } from 'typebox/value';
import { VerificationSubmissionV3Schema, operationNeedsVerification, type GoalCheck, type OperationView,
  type VerificationSubmissionV3 } from '@cloudhelm/contracts';
import { hasJournalCredentials } from './journal-secrets.js';
import { mergeOperationViews } from './runtime-facts.js';
import { eligibleObservation } from './verification-feedback.js';
import { evaluateRunOutput, normalize } from './verification-output.js';

export function validateSubmissionV3(taskId: string, value: unknown, round: OperationView[], all: OperationView[]) {
  const reject = (code: string, guidance: string) => ({ accepted: false as const, code, guidance });
  if (!Value.Check(VerificationSubmissionV3Schema, value)) return reject('verification-fields-invalid', '请使用version=3；只需可选的summary、recovery和checks，不必手填操作清单或证据并集。');
  if (hasJournalCredentials(JSON.stringify(value))) return reject('verification-secret', '提交含疑似凭据，未保存；不要重复这些内容。');
  if (mergeOperationViews(all).some((op) => op.taskId === taskId && operationNeedsVerification(op))) return reject('verification-outcome-unresolved', '仍有未决远端结果；报告不能解除结果锁，也不能重放原操作。');
  const operations = mergeOperationViews(round).filter((op) => op.taskId === taskId);
  const checks: GoalCheck[] = [];
  for (const check of value.checks ?? []) {
    const id = check.kind === 'run-output' ? check.operationId : check.evidenceOperationId;
    const operation = operations.find((op) => op.id === id);
    if (!operation) return reject('verification-source-invalid', '观察来源不在本对话当前验收范围；请引用已有本轮操作，不要重放。');
    if (check.kind === 'run-output') {
      if (operation.kind !== 'command') return reject('verification-source-invalid', 'run-output只能比较真实命令的执行输出，不能用文件操作代替。');
      if (operation.outputExpectation && (normalize(operation.outputExpectation.expectedOutput) !== normalize(check.expectedOutput)
        || (operation.outputExpectation.expectedExitCode ?? 0) !== (check.expectedExitCode ?? 0))) return reject('verification-expectation-bound',
        '此操作的输出预期已在执行前绑定；不能事后修改预期来制造通过。请说明实际结果。');
      checks.push(evaluateRunOutput(operation, check));
    } else {
      if (!eligibleObservation({ operation, index: 0 })) return reject('verification-source-invalid', '状态判断须引用已退出的合格只读观察；模型判断不会标成后端证明。');
      checks.push({ kind: 'model-assessment', authority: 'model', target: check.target, expected: check.expected,
        observed: check.observed, status: check.status, operationIds: [operation.id] });
    }
  }
  return { accepted: true as const, submission: structuredClone(value) as VerificationSubmissionV3, checks };
}
