import { operationNeedsVerification, type OperationView, type ResumeReason, type VerificationState } from '@cloudhelm/contracts';
import { mergeOperationViews } from './runtime-facts.js';

/** An unclassified success requires evidence; this does not assert a mutation occurred. */
export function reportRequiredOperations(operations: readonly OperationView[]): OperationView[] {
  return mergeOperationViews(operations).filter((operation) => operation.status === 'succeeded' && operation.readOnly !== true);
}

export interface TaskCompletion {
  status: 'paused' | 'failed' | 'answered';
  resumeReason?: ResumeReason;
  summary?: string;
  /** null clears obsolete report state; undefined leaves it untouched while blocked. */
  verificationState?: VerificationState | null;
}

/** Pure projection of settled model and backend operation evidence. Never executes or authorizes work. */
export function decideTaskCompletion(input: {
  operations: readonly OperationView[];
  roundOperations: readonly OperationView[];
  answered: boolean;
  hasReport: boolean;
  reportIssue?: { code: string; guidance: string };
  reportStatus?: 'verified' | 'unverified';
  reportUnverifiedReason?: VerificationState['reasonCode'];
}): TaskCompletion {
  if (mergeOperationViews(input.operations).some(operationNeedsVerification)) return {
    status: 'paused', resumeReason: 'verify',
    summary: '远端操作结果尚未确定且未排除变更，请先核验原操作，禁止直接重试。'
  };
  if (!input.answered) return { status: 'failed', resumeReason: 'model', summary: '模型未给出完整答复，请根据已取得的结果继续。' };
  const candidates = reportRequiredOperations(input.roundOperations);
  if (!candidates.length) return { status: 'answered', verificationState: null };
  const verified = input.hasReport && input.reportStatus !== 'unverified';
  const verificationState: VerificationState = { status: verified ? 'verified' : 'unverified',
    operationIds: candidates.map((operation) => operation.id),
    ...input.hasReport ? input.reportUnverifiedReason ? { reasonCode: input.reportUnverifiedReason } : {} : { reasonCode: 'report-missing' as const } };
  if (input.hasReport && !verified) return { status: 'answered', verificationState,
    summary: '检查已登记，但存在失败、无法确定或未验证的结果；这不是全部通过的证明，不会为凑通过而自动重放。' };
  return input.hasReport ? { status: 'answered', verificationState } : {
    status: 'answered', resumeReason: 'report', verificationState,
    summary: `远端操作已返回成功，但尚缺效果核验证据。${input.reportIssue?.guidance ?? '请查看已有检查或继续核验。'}`
  };
}
