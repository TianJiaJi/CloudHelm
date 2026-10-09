import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation } from '@cloudhelm/core';

/** Serializes Agent writes across tasks sharing one target host. */
export class HostSerialExecutor implements OperationExecutor {
  private readonly reads = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly unsettled = new Map<string, Map<string, Promise<'exited' | 'unknown'> | null>>();

  constructor(private readonly downstream: OperationExecutor) {}

  restore(operations: Array<{ id: string; hostId: string }>): void {
    for (const operation of operations) {
      if (!this.unsettled.get(operation.hostId)?.has(operation.id)) this.track(operation.hostId, operation.id, null);
    }
  }

  /** Late PTY evidence can arrive after the model/tool already stopped. */
  observe(hostId: string, result: OperationResult): void {
    const pending = this.unsettled.get(hostId);
    if (!pending?.has(result.operationId)) return;
    const unresolved = result.status === 'unknown' || result.status === 'handed-over'
      || (result.status === 'failed' && result.effects === 'possible' && !this.reads.has(result.operationId));
    if (unresolved) pending.set(result.operationId, null);
    else pending.delete(result.operationId);
    this.reads.delete(result.operationId);
    if (!pending.size) this.unsettled.delete(hostId);
  }

  reconcile(hostId: string, operationId: string): boolean {
    const operations = this.unsettled.get(hostId);
    if (operations?.get(operationId)) return false;
    operations?.delete(operationId);
    this.reads.delete(operationId);
    if (!operations?.size) this.unsettled.delete(hostId);
    return true;
  }

  private track(hostId: string, operationId: string, completion: Promise<'exited' | 'unknown'> | null): void {
    const operations = this.unsettled.get(hostId) ?? new Map();
    operations.set(operationId, completion);
    this.unsettled.set(hostId, operations);
    if (completion) void completion.then((status) => {
      if (operations.get(operationId) !== completion) return;
      if (status === 'exited') operations.delete(operationId);
      else operations.set(operationId, null);
      if (!operations.size) this.unsettled.delete(hostId);
    }).catch(() => { if (operations.get(operationId) === completion) operations.set(operationId, null); });
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    const hostId = operation.scope.hostId;
    const previous = this.tails.get(hostId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(hostId, tail);
    await previous;
    try {
      if (signal?.aborted || options?.isAuthorized?.() === false) {
        return { operationId: operation.id, status: 'failed', effects: 'none', stdoutTail: 'Authorization expired while waiting for the host write lock; no operation was sent' };
      }
      if (this.unsettled.has(hostId) && !options?.readOnly) {
        return { operationId: operation.id, status: 'failed', effects: 'none',
          stdoutTail: 'Another command on this host has an unresolved remote outcome; verify it before further Agent writes' };
      }
      let result: OperationResult;
      try { result = await this.downstream.execute(operation, fingerprint, signal, options); }
      catch (error) {
        this.track(hostId, operation.id, null);
        throw error;
      }
      if (result.remoteCompletion) {
        if (options?.readOnly) this.reads.add(operation.id);
        this.track(hostId, operation.id, result.remoteCompletion);
        void result.remoteCompletion.finally(() => this.reads.delete(operation.id)).catch(() => {});
      }
      else if (result.status === 'unknown' || result.status === 'handed-over'
        || (result.status === 'failed' && result.effects === 'possible' && !options?.readOnly)) this.track(hostId, operation.id, null);
      return result;
    } finally {
      release();
      if (this.tails.get(hostId) === tail) this.tails.delete(hostId);
    }
  }
}
