import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation } from '@cloudhelm/core';

/**
 * Serializes Agent writes across tasks sharing one target host.
 *
 * Outcome state transitions guarded here:
 * - running → succeeded | failed | unknown on real terminal evidence, including
 *   late PTY exits that arrive after the tool call already returned;
 * - unknown / failed-with-possible-effects → resolved only through fresh
 *   same-host evidence or an explicit recorded user risk acceptance — never by
 *   replaying the original action;
 * - resolved stays resolved for this process; restore() re-arms locks from the
 *   persisted unresolved set after a restart.
 *
 * Invariants:
 * - While any non-read-only operation on the host has an unresolved outcome,
 *   every further write is refused before dispatch regardless of how low-risk
 *   the new write is; read-only inspection stays available.
 * - An operation with a live remote completion promise is still running and
 *   cannot be reconciled away.
 */
export class HostSerialExecutor implements OperationExecutor {
  private readonly tails = new Map<string, Promise<void>>();
  /** Hold raw exit observations until authentication/decorators finish validating the result. */
  private readonly backgroundObservations = new Map<string, OperationResult | undefined>();
  private readonly unsettled = new Map<string, Map<string, Promise<'exited' | 'unknown'> | null>>();

  constructor(private readonly downstream: OperationExecutor) {}

  restore(operations: Array<{ id: string; hostId: string }>): void {
    for (const operation of operations) {
      if (!this.unsettled.get(operation.hostId)?.has(operation.id)) this.track(operation.hostId, operation.id, null);
    }
  }

  /** Late PTY evidence can arrive after the model/tool already stopped. */
  observe(hostId: string, result: OperationResult): void {
    const key = JSON.stringify([hostId, result.operationId]);
    if (this.backgroundObservations.has(key)) { this.backgroundObservations.set(key, result); return; }
    const pending = this.unsettled.get(hostId);
    if (!pending?.has(result.operationId)) return;
    const unresolved = result.status === 'unknown' || result.status === 'handed-over'
      || (result.status === 'failed' && result.effects === 'possible');
    if (unresolved) pending.set(result.operationId, null);
    else pending.delete(result.operationId);
    if (!pending.size) this.unsettled.delete(hostId);
  }

  /** A live remote completion cannot be overridden even by a risk acceptance. */
  canReconcile(hostId: string, operationId: string): boolean {
    return !this.unsettled.get(hostId)?.get(operationId);
  }

  /** Releases one unresolved record after evidence or an explicit risk acceptance. */
  reconcile(hostId: string, operationId: string): boolean {
    const operations = this.unsettled.get(hostId);
    if (!this.canReconcile(hostId, operationId)) return false;
    operations?.delete(operationId);
    if (!operations?.size) this.unsettled.delete(hostId);
    return true;
  }

  canControlOperation(hostId: string, operationId: string): boolean {
    if (this.tails.has(hostId)) return false;
    const pending = this.unsettled.get(hostId);
    return !pending?.size || pending.size === 1 && !!pending.get(operationId);
  }

  /** Observation only: manual scheduled maintenance must not collide with Agent work. */
  hasPendingOrUnresolved(hostId: string): boolean { return this.tails.has(hostId) || this.unsettled.has(hostId); }

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
    const releaseQueue = () => { release(); if (this.tails.get(hostId) === tail) this.tails.delete(hostId); };
    const observationKey = JSON.stringify([hostId, operation.id]);
    let yielded = false, completeBackground: ((state: 'unknown') => void) | undefined;
    const background = operation.kind === 'command' && operation.executionMode === 'background';
    const executionOptions: ExecutionOptions | undefined = background ? { ...options, onProcessStarted: (event) => {
      if (!yielded) {
        yielded = true;
        if (!options?.readOnly) {
          this.backgroundObservations.set(observationKey, undefined);
          const completion = new Promise<'exited' | 'unknown'>((resolve) => { completeBackground = resolve; });
          this.track(hostId, operation.id, completion);
        }
        // Publish/persist before admitting diagnostic work. If the observer fails,
        // downstream fails closed and the finally path releases only the queue, not the write lock.
        options?.onProcessStarted?.(event);
        releaseQueue();
      } else options?.onProcessStarted?.(event);
    } } : options;
    try {
      if (signal?.aborted || options?.isAuthorized?.() === false) {
        return { operationId: operation.id, status: 'failed', effects: 'none', stdoutTail: 'Authorization expired while waiting for the host write lock; no operation was sent' };
      }
      if (this.unsettled.has(hostId) && !options?.readOnly) {
        const blockedBy = [...this.unsettled.get(hostId)!.keys()].slice(0, 3).join(', ');
        return { operationId: operation.id, status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation',
          stdoutTail: `Another command on this host has an unresolved remote outcome (${blockedBy}); verify it before further Agent writes` };
      }
      let result: OperationResult;
      try { result = await this.downstream.execute(operation, fingerprint, signal, executionOptions); }
      catch (error) {
        if (!options?.readOnly) this.track(hostId, operation.id, null);
        throw error;
      }
      const late = this.backgroundObservations.get(observationKey);
      this.backgroundObservations.delete(observationKey);
      const unresolved = result.status === 'unknown' || result.status === 'handed-over'
        || (result.status === 'failed' && result.effects === 'possible');
      if (!options?.readOnly && unresolved) {
        this.track(hostId, operation.id, result.remoteCompletion ?? null);
        if (late && ['unknown', 'handed-over'].includes(result.status)) this.observe(hostId, late);
      }
      else if (yielded && !options?.readOnly) this.observe(hostId, result);
      return result;
    } finally {
      this.backgroundObservations.delete(observationKey);
      completeBackground?.('unknown');
      releaseQueue();
    }
  }
}
