import { operationNeedsVerification, type OperationView, type ResumeReason, type VerificationState, type VerificationFacts } from '@cloudhelm/contracts';
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
  reportFacts?: VerificationFacts;
}): TaskCompletion {
  if (mergeOperationViews(input.operations).some(operationNeedsVerification)) return {
    status: 'paused', resumeReason: 'verify',
    summary: '远端操作结果尚未确定且未排除变更，请先核验原操作，禁止直接重试。'
  };
  if (!input.answered) return { status: 'failed', resumeReason: 'model', summary: '模型未给出完整答复，请根据已取得的结果继续。' };
  const candidates = reportRequiredOperations(input.roundOperations);
  if (!candidates.length && !input.reportFacts) return { status: 'answered', verificationState: null };
  const verified = input.hasReport && input.reportStatus !== 'unverified';
  const verificationState: VerificationState = { status: verified ? 'verified' : 'unverified',
    operationIds: [...new Set([...candidates.map((operation) => operation.id), ...(input.reportFacts?.riskOperationIds ?? [])])],
    ...input.hasReport ? input.reportUnverifiedReason ? { reasonCode: input.reportUnverifiedReason } : {} : { reasonCode: 'goals-not-checked' as const } };
  if (input.hasReport && !verified) return { status: 'answered', verificationState,
    summary: input.reportFacts ? '执行、运行观察、目标比较与风险已分别登记；请以具体记录为准，不为补报告自动重放。'
      : '检查已登记，但存在失败、无法确定或未验证的结果；这不是全部通过的证明，不会为凑通过而自动重放。' };
  return input.hasReport ? { status: 'answered', verificationState } : {
    status: 'answered', verificationState,
    summary: '执行记录已保留，目标效果尚未取得充分证据；无需反复提交报告或重放已完成操作。'
  };
}
