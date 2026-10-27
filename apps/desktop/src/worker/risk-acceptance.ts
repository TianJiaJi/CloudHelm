import { operationOutcomeResolvable, type OperationView } from '@cloudhelm/contracts';

/** Only a main-process committed acceptance may synchronize an otherwise resolved worker view. */
export function assertCommittedRiskAcceptance(accepted: OperationView): void {
  if (!Number.isFinite(accepted.reconciledAt) || !accepted.reconciledAt || accepted.reconciledAt < 0
    || accepted.reconciliation?.kind !== 'risk-accepted' || accepted.reconciliation.at !== accepted.reconciledAt
    || !operationOutcomeResolvable({ ...accepted, reconciledAt: undefined })) {
    throw new Error('无效的已持久化风险确认记录，未解除写锁');
  }
}

export function applyCommittedRiskAcceptance(current: OperationView, accepted: OperationView): OperationView {
  assertCommittedRiskAcceptance(accepted);
  if (current.id !== accepted.id || current.taskId !== accepted.taskId
    || current.hostId !== accepted.hostId || current.kind !== accepted.kind) throw new Error('风险确认与原操作身份不匹配');
  // A competing evidence assessment is not an actual exit observation. Main's
  // persisted acceptance wins that race, but real late exit evidence is retained.
  const observed = current.reconciliation?.kind !== 'evidence' && (current.status === 'succeeded'
    || (current.status === 'failed' && Number.isInteger(current.exitCode) && current.exitCode! >= 0));
  return structuredClone({ ...(observed ? current : accepted), reconciledAt: accepted.reconciledAt,
    reconciliation: accepted.reconciliation });
}
