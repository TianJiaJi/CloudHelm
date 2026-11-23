import { operationOutcomeResolvable, type OperationView, type RecoveryActionKind, type RecoveryDecisionRecord } from '@cloudhelm/contracts';
import type { SqliteStore } from '@cloudhelm/adapters';

export interface RecoveryDisposition { action: RecoveryActionKind; actionId: string }

/**
 * Durable recovery decisions: the audit trail and idempotency ledger of the
 * unified recovery use case. Acceptance keeps the recorded outcome unknown and
 * only releases the write lock; rejection never touches the lock.
 */
export class RecoveryDecisionStore {
  constructor(private readonly store: SqliteStore,
    private readonly operations: Map<string, OperationView>,
    private readonly publish: () => void,
    private readonly observe?: (operation: OperationView) => void) {}

  /** Persists an explicit user risk acceptance. The remote outcome stays unknown:
   * this only records that the user took over the risk so the write lock can be
   * released. Callers re-arm the write lock when this throws. */
  accept(operationId: string, explanation: string, at: number, sourceTaskId?: string,
    evidenceOperationIds?: string[], disposition?: RecoveryDisposition): OperationView {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error('未找到该操作');
    if (operation.reconciledAt) {
      if (operation.reconciliation?.kind === 'risk-accepted' && operation.reconciliation.at === at) return structuredClone(operation);
      throw new Error('该操作已经核验或确认，不能重复解除');
    }
    if (!operationOutcomeResolvable(operation)) throw new Error('该操作没有可确认的未知结果');
    const decision: RecoveryDecisionRecord | undefined = disposition
      ? { version: 1, actionId: disposition.actionId, action: disposition.action, at,
        ...(sourceTaskId ? { sourceTaskId } : {}), released: true, resumed: false } : undefined;
    const updated: OperationView = { ...operation, reconciledAt: at,
      reconciliation: { kind: 'risk-accepted', explanation, at, sourceTaskId, evidenceOperationIds,
        ...(disposition ? { action: disposition.action } : {}) },
      ...(decision ? { recoveryDecision: decision } : {}) };
    this.commit(operationId, updated);
    return structuredClone(updated);
  }

  /** Records an explicit rejection without releasing anything; the operation stays resolvable. */
  recordRejection(operationId: string, actionId: string, at: number, sourceTaskId?: string, explanation?: string): OperationView {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error('未找到该操作');
    if (operation.recoveryDecision?.actionId === actionId) return structuredClone(operation);
    if (operation.reconciledAt) throw new Error('该操作已经核验或确认，不能重复解除');
    if (!operationOutcomeResolvable(operation)) throw new Error('该操作没有可确认的未知结果');
    const updated: OperationView = { ...operation,
      recoveryDecision: { version: 1, actionId, action: 'reject', at,
        ...(sourceTaskId ? { sourceTaskId } : {}), ...(explanation ? { explanation } : {}), released: false, resumed: false } };
    this.commit(operationId, updated);
    return structuredClone(updated);
  }

  /** Updates the continuation part of the latest decision; audit only. */
  update(operationId: string, patch: Partial<Pick<RecoveryDecisionRecord, 'resumed' | 'resumeNote' | 'error'>>): void {
    const operation = this.operations.get(operationId);
    if (!operation?.recoveryDecision) throw new Error('未找到该操作的处置记录');
    const decision: RecoveryDecisionRecord = { ...operation.recoveryDecision, ...patch };
    this.commit(operationId, { ...operation, recoveryDecision: decision });
  }

  private commit(operationId: string, updated: OperationView): void {
    this.store.put('operations', operationId, updated);
    this.operations.set(operationId, updated);
    try { this.observe?.(updated); } catch { /* Debug capture cannot affect recovery. */ }
    this.publish();
  }
}
