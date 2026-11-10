import { ExecutionJobs } from '@cloudhelm/application';
import type { OperationView } from '@cloudhelm/contracts';

/** Offline backend projection. Never opens SSH or turns a stop receipt into exit evidence. */
export function recoverOperation(value: OperationView, reason: string): OperationView {
  const operation = structuredClone(value);
  operation.manualReviewAvailable = false;
  if (['proposed', 'approved', 'running'].includes(operation.status)) Object.assign(operation, { status: 'unknown', reason });
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
