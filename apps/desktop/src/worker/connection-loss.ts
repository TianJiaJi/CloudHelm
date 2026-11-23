import type { ConnectionLossClassification, ConnectionLossOperation, ConnectionLossRecord, OperationView } from '@cloudhelm/contracts';

export interface ConnectionLossInput {
  hostId: string;
  lostAt: number;
  /** Current-session operation views captured before pausing or terminal closure settles anything. */
  operations: readonly OperationView[];
  /** Task-scoped ids of commands still executing on a terminal channel. */
  pendingOperationIds: readonly string[];
}

/** §7.1 reduction point: one immutable loss-time evidence record built from
 * pre-pause views. Proposed or approved work never reached the host; anything
 * dispatched, unsettled or already unknown counts as handed off or boundary
 * unclear unless the backend observed completion. Internal probes and reconciled
 * operations belong to other bookkeeping; prior-session operations stay with the
 * session that recorded them. Later observations never revise this record. */
export function classifyConnectionLoss(input: ConnectionLossInput): ConnectionLossRecord {
  const pending = new Set(input.pendingOperationIds);
  const affected = input.operations.filter((operation) => operation.hostId === input.hostId
    && !operation.internal && !operation.reconciledAt
    && (pending.has(operation.id) || ['proposed', 'approved', 'running', 'unknown'].includes(operation.status)));
  const operations: ConnectionLossOperation[] = affected.map((operation) => {
    const classification: ConnectionLossClassification = operation.exitObserved ? 'observed-complete'
      : pending.has(operation.id) || !['proposed', 'approved'].includes(operation.status)
        ? 'handed-off-or-unclear' : 'not-handed-off';
    return { operationId: operation.id, classification, ...(operation.readOnly ? { readOnly: true } : {}) };
  });
  return { version: 1, hostId: input.hostId, lostAt: input.lostAt, operations };
}

/** User-facing record summary; states exactly what the evidence does not prove. */
export function connectionLossText(record: ConnectionLossRecord): string {
  const count = (classification: ConnectionLossClassification) =>
    record.operations.filter((operation) => operation.classification === classification).length;
  const detail = record.operations.length
    ? `断线时共 ${record.operations.length} 项在途或待发操作：未交接 ${count('not-handed-off')}、已观察完成 ${count('observed-complete')}、已交接或边界不明 ${count('handed-off-or-unclear')}。已交接或边界不明的操作不会自动重放，重连后先核验。`
    : '断线时没有记录到在途或待发操作。';
  return `与主机 ${record.hostId} 的连接中断。${detail}重连成功不代表断线前的操作已完成。`;
}
