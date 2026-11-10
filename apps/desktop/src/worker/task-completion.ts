import { operationNeedsVerification, type OperationView, type ResumeReason, type VerificationState, type VerificationFacts } from '@cloudhelm/contracts';
import { mergeOperationViews } from './runtime-facts.js';

/** Legacy name: selects operations for fact recording, not a completion requirement or mutation assertion. */
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
  if (mergeOperationViews(input.operations).some((operation) => {
    const job = operation.executionJob;
    // Only the reply finishes. A live background operation stays visible and keeps its write lock.
    if (operation.status === 'running' && job?.version === 1 && job.operationId === operation.id
      && job.taskId === operation.taskId && job.hostId === operation.hostId && ['running', 'stop-requested'].includes(job.status)) return false;
    return operationNeedsVerification(operation);
  })) return {
    status: 'paused', resumeReason: 'verify',
    summary: '远端操作结果尚未确定且未排除变更，请先核验原操作，禁止直接重试。'
  };
  if (!input.answered) return { status: 'failed', resumeReason: 'model', summary: '模型未给出完整答复，请根据已取得的结果继续。' };
  // Ending a response is not a business verdict. Keep checks/failures in the immutable
  // operation/report records, not a generic verified/unverified completion requirement.
  return { status: 'answered', verificationState: null };
}
