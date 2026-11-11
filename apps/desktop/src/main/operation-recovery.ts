import { ExecutionJobs } from '@cloudhelm/application';
import type { OperationView } from '@cloudhelm/contracts';

/** Offline backend projection. Never opens SSH or turns a stop receipt into exit evidence. */
export function recoverOperation(value: OperationView, reason: string): OperationView {
  const operation = structuredClone(value);
  operation.manualReviewAvailable = false;
  if (operation.status === 'running') Object.assign(operation, { status: 'unknown', reason });
  else if (operation.status === 'proposed' || (operation.status === 'approved' && !operation.executionJob)) {
    // Provably never dispatched: proposed was never approved, or approved but no execution record exists.
    Object.assign(operation, { status: 'failed', effects: 'none', failureKind: 'not-dispatched',
      reason: '操作未派发，已安全终止。' });
  } else if (operation.status === 'approved') Object.assign(operation, { status: 'unknown', reason });
  if (!operation.executionJob) return operation;
  const job = operation.executionJob;
  try {
    if (job.operationId !== operation.id || job.taskId !== operation.taskId || job.hostId !== operation.hostId)
      throw new Error('Job recipient mismatch');
    if (operation.exitObserved && Number.isSafeInteger(operation.exitCode) && operation.exitCode! >= 0
      && ['succeeded', 'failed'].includes(operation.status)) Object.assign(job, {
      status: operation.exitCode === 0 ? 'exited' : 'failed', exitObserved: true, exitCode: operation.exitCode, endedAt: operation.completedAt });
    const ledger = new ExecutionJobs(operation.taskId, () => {}, 1);
    ledger.restore([job]);
    operation.executionJob = ledger.get(job.jobId)!;
    if (operation.executionJob.exitObserved) Object.assign(operation, {
      status: operation.executionJob.exitCode === 0 ? 'succeeded' : 'failed', exitObserved: true,
      exitCode: operation.executionJob.exitCode, completedAt: operation.executionJob.endedAt ?? operation.completedAt });
    else if (operation.executionJob.status === 'unknown') Object.assign(operation, { status: 'unknown', reason });
  } catch {
    // Invalid capability data is never published or revived; failure never implies no effects.
    delete operation.executionJob;
    Object.assign(operation, { status: 'unknown', reason: '后台任务记录无效，原操作结果待人工核验。' });
  }
  return operation;
}
