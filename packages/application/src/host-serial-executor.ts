import type { ExecutionOptions, HostRiskBinding, OperationExecutor, OperationResult, ProposedOperation } from '@cloudhelm/core';
import { HostRiskDomains } from './host-risk-domains.js';

/** Same verdict as the persisted view rule (contracts operationNeedsVerification):
 * a failure whose effects were not proven absent still holds the host write lock,
 * both now and after a restart. Only an explicit effects:'none' releases it. */
const unresolvedResult = (result: Pick<OperationResult, 'status' | 'effects'>): boolean =>
  result.status === 'unknown' || result.status === 'handed-over'
  || (result.status === 'failed' && result.effects !== 'none');

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
  private readonly domains = new HostRiskDomains();
  /** Hold raw exit observations until authentication/decorators finish validating the result. */
  private readonly backgroundObservations = new Map<string, OperationResult | undefined>();
  private readonly unsettled = new Map<string, Map<string, Promise<'exited' | 'unknown'> | null>>();

  constructor(private readonly downstream: OperationExecutor) {}
  get supportsFileTransactions(): boolean { return this.downstream.supportsFileTransactions === true; }

  bindRiskDomains(bindings: readonly HostRiskBinding[]): void {
    this.domains.bind(bindings, (hostId) => this.tails.has(hostId)
      || [...this.unsettled.get(hostId)?.values() ?? []].some((completion) => completion !== null));
  }

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
    if (unresolvedResult(result)) pending.set(result.operationId, null);
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
    const peers = [...this.domains.peers(hostId)];
    if (peers.some((id) => this.tails.has(id))) return false;
    const pending = peers.flatMap((id) => [...this.unsettled.get(id) ?? []].map(([operationId, completion]) => ({ hostId: id, operationId, completion })));
    return !pending.length || pending.length === 1 && pending[0]!.hostId === hostId
      && pending[0]!.operationId === operationId && !!pending[0]!.completion;
  }

  /** Observation only: manual scheduled maintenance must not collide with Agent work. */
  hasPendingOrUnresolved(hostId: string): boolean {
    return [...this.domains.peers(hostId)].some((id) => this.tails.has(id) || this.unsettled.has(id));
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
    const waits = [...this.domains.peers(hostId)].flatMap((id) => this.tails.has(id) ? [this.tails.get(id)!] : []);
    const previous = waits.length > 1 ? Promise.all(waits).then(() => undefined) : waits[0] ?? Promise.resolve();
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
      let admitted = false;
      try {
        admitted = !signal?.aborted && options?.isAuthorized?.() !== false && options?.canEnterExecutor?.() !== false;
      } catch { /* A broken admission callback cannot dispatch or strand the queue. */ }
      if (!admitted) {
        return { operationId: operation.id, status: 'failed', effects: 'none', failureKind: 'not-dispatched',
          stdoutTail: 'Authorization expired while waiting for the host write lock; no operation was sent' };
      }
      const unresolvedPeers = [...this.domains.peers(hostId)].filter((id) => this.unsettled.has(id));
      if (unresolvedPeers.length && !options?.readOnly) {
        // A tracked, still-alive background job is a running resource, not an unknown
        // outcome. Both keep the write lock (a background marker is never permission),
        // but they need different next actions: wait for it to finish, or verify what
        // already happened. Read-only inspection is allowed in both cases.
        const alive = (id: string) => [...this.unsettled.get(id)!.entries()].filter(([, completion]) => completion !== null).map(([operationId]) => operationId);
        const unknown = (id: string) => [...this.unsettled.get(id)!.entries()].filter(([, completion]) => completion === null).map(([operationId]) => operationId);
        const running = unresolvedPeers.flatMap(alive).slice(0, 3).join(', ');
        const unresolved = unresolvedPeers.flatMap(unknown).slice(0, 3).join(', ');
        const detail = running && unresolved ? `still running in the background (${running}); unresolved outcome (${unresolved})`
          : running ? `still running in the background (${running}); its outcome is unknown until it exits`
            : `has an unresolved remote outcome (${unresolved})`;
        return { operationId: operation.id, status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation',
          stdoutTail: `Another command on this host is ${detail}. Read-only inspection may continue; verify the original outcome before further Agent writes` };
      }
      let result: OperationResult;
      try { result = await this.downstream.execute(operation, fingerprint, signal, executionOptions); }
      catch (error) {
        if (!options?.readOnly) this.track(hostId, operation.id, null);
        throw error;
      }
      const late = this.backgroundObservations.get(observationKey);
      this.backgroundObservations.delete(observationKey);
      if (!options?.readOnly && unresolvedResult(result)) {
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
