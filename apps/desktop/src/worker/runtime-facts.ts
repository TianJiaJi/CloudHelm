import { operationNeedsVerification, operationOutcomeResolvable, type OperationView } from '@cloudhelm/contracts';

/** Current snapshots replace old ones without moving an operation's position in its round. */
export function mergeOperationViews(operations: readonly OperationView[]): OperationView[] {
  const indexed = new Map<string, OperationView>();
  for (const operation of operations) {
    const previous = indexed.get(operation.id);
    if (previous && (previous.taskId !== operation.taskId || previous.hostId !== operation.hostId)) {
      throw new Error('Operation identity changed while projecting runtime state');
    }
    indexed.set(operation.id, operation);
  }
  return [...indexed.values()];
}

export function isReconciliationEvidence(target: OperationView, evidence: OperationView): boolean {
  return evidence.id !== target.id && evidence.taskId === target.taskId && evidence.hostId === target.hostId
    && evidence.createdAt > target.createdAt && evidence.kind === 'command' && evidence.readOnly === true
    && evidence.status === 'succeeded' && evidence.reconciliation?.kind !== 'risk-accepted';
}

/** Bounded backend facts, not command output, user explanations or fresh authorization. */
export function runtimeFacts(operations: readonly OperationView[]) {
  const current = mergeOperationViews(operations);
  const unresolved = current.filter(operationNeedsVerification);
  const recentlyResolved = current.filter((operation) => operation.reconciledAt !== undefined)
    .sort((left, right) => right.reconciledAt! - left.reconciledAt!).slice(0, 12);
  const selected = mergeOperationViews([...current.slice(-12), ...recentlyResolved, ...unresolved]);
  if (selected.length > 64) throw new Error('未决操作引用过多，请先通过主机恢复卡处理；不会省略安全状态后继续。');
  const references = selected.map((operation) => {
    const { id, hostId, kind, status, exitCode, authentication, failureKind, effects, serviceUnit, reconciledAt } = operation;
    const resolution = operation.reconciliation;
    return { id, hostId, kind, status, exitCode, authentication, failureKind, effects, serviceUnit,
      readOnly: operation.readOnly ?? null, reconciledAt,
      reconciliation: resolution ? { kind: resolution.kind, at: resolution.at,
        ...(resolution.kind === 'evidence' ? { outcome: resolution.outcome,
          evidenceOperationIds: resolution.evidenceOperationIds?.slice(-5) } : {}) } : undefined,
      needsVerification: operationNeedsVerification(operation), canReconcile: operationOutcomeResolvable(operation),
      eligibleEvidenceOperationIds: operationOutcomeResolvable(operation)
        ? current.filter((evidence) => isReconciliationEvidence(operation, evidence)).slice(-5).map((evidence) => evidence.id) : [] };
  });
  const facts = { version: 1 as const, unresolvedOperationIds: unresolved.map((operation) => operation.id),
    reconcilableOperationIds: current.filter(operationOutcomeResolvable).map((operation) => operation.id), references };
  if (JSON.stringify(facts).length > 16_384) throw new Error('恢复状态超出安全上下文上限，请先缩小未决操作范围；不会静默截断。');
  return facts;
}
