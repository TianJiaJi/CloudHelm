import { randomUUID } from 'node:crypto';
import { operationNeedsVerification, type AppEvent, type OperationView, type TaskView, type VerificationRound } from '@cloudhelm/contracts';

/** Explicit persisted membership. Continuation, report repair and chat wording never infer acceptance. */
export class VerificationRoundTracker {
  private value: VerificationRound;
  constructor(task: TaskView, operations: OperationView[], private readonly emit: (event: AppEvent) => void) {
    if (task.verificationRound) this.value = structuredClone(task.verificationRound);
    else {
      const pending = task.resumeReason === 'report' || task.verificationState?.status === 'unverified' && !task.report;
      const first = operations.findIndex((op) => operationNeedsVerification(op) || pending && task.verificationState?.operationIds.includes(op.id));
      this.value = { version: 1, id: randomUUID(), closed: first < 0 && !pending && task.status === 'answered',
        operationIds: first >= 0 ? operations.slice(first).map((op) => op.id) : pending ? operations.map((op) => op.id) : [] };
    }
    this.publish(task.id);
  }
  get id(): string { return this.value.id; }
  get closed(): boolean { return this.value.closed; }
  operations(operations: OperationView[]): OperationView[] {
    const indexed = new Map(operations.map((op) => [op.id, op]));
    return this.value.operationIds.flatMap((id) => indexed.has(id) ? [indexed.get(id)!] : []);
  }
  begin(taskId: string): void {
    this.value = { version: 1, id: randomUUID(), closed: false, operationIds: [] };
    this.publish(taskId);
  }
  record(taskId: string, operationId: string): void {
    if (this.value.operationIds.includes(operationId)) return;
    this.value.operationIds.push(operationId);
    this.publish(taskId);
  }
  pending(taskId: string, operation: OperationView, operations: OperationView[]): void {
    if (operation.status !== 'succeeded' || operation.readOnly === true) return;
    const operationIds = this.operations(operations).filter((op) => op.status === 'succeeded' && op.readOnly !== true).map((op) => op.id);
    this.emit({ type: 'verification-state', taskId, value: { status: 'unverified', operationIds, reasonCode: 'report-missing' } });
  }
  close(taskId: string): void { this.value.closed = true; this.publish(taskId); }
  private publish(taskId: string): void { this.emit({ type: 'verification-round', taskId, value: structuredClone(this.value) }); }
}
