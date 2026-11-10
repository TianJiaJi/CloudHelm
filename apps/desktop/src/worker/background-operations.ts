import { randomUUID } from 'node:crypto';
import { ExecutionJobs } from '@cloudhelm/application';
import { operationOutcome, type ExecutionJobBinding, type ExecutionJobSnapshot, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';

type Feedback = Awaited<ReturnType<RemoteToolDependencies['runOperation']>>;
interface Context {
  controller: AbortController;
  unlink(): void;
  detached: boolean;
  finished: boolean;
  operations: Set<string>;
}
interface Active {
  context: Context;
  binding?: ExecutionJobBinding;
  detached: boolean;
  ready(feedback: Feedback): void;
}

/** Keeps the full audited executor alive after returning a transport-confirmed start.
 * Model cancellation is linked until that start, never mistaken for remote termination.
 * All lifecycle writes are backend-only; no model-facing setter is exposed. */
export class BackgroundOperations {
  private closed = false;
  private readonly contexts = new WeakMap<AbortSignal, Context>();
  private readonly active = new Map<string, Active>();
  private readonly jobs: ExecutionJobs;
  constructor(taskId: string, persist: (job: ExecutionJobSnapshot) => void, private readonly idle: () => void = () => {}) {
    this.jobs = new ExecutionJobs(taskId, persist);
  }

  async withLifetime(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<Feedback>): Promise<Feedback> {
    if (this.closed) throw new Error('Background execution runtime closed');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const context: Context = { controller, detached: false, finished: false, operations: new Set(),
      unlink: () => signal?.removeEventListener('abort', abort) };
    this.contexts.set(controller.signal, context);
    signal?.addEventListener('abort', abort, { once: true });
    try { return await run(controller.signal); }
    finally { context.finished = true; this.cleanup(context); }
  }

  async run(operation: ProposedOperation, signal: AbortSignal | undefined, dispatch: () => Promise<Feedback>): Promise<Feedback> {
    if (operation.kind !== 'command' || operation.executionMode !== 'background') return dispatch();
    const context = signal && this.contexts.get(signal);
    if (!context || !signal || signal.aborted || context.detached || this.closed) throw new Error('Background operation lifetime is unavailable');
    if (this.active.has(operation.id)) throw new Error('Background operation already active; do not replay');
    let ready!: (feedback: Feedback) => void;
    const started = new Promise<Feedback>((resolve) => { ready = resolve; });
    const entry: Active = { context, detached: false, ready };
    this.active.set(operation.id, entry); context.operations.add(operation.id);
    const finished = this.finish(operation.id, entry, dispatch);
    return Promise.race([started, finished]);
  }

  /** Called after the exact prepared operation is recorded by SafetyGate.audit.proposed. */
  proposed(operation: ProposedOperation, connectionId: string): void {
    if (operation.kind !== 'command' || operation.executionMode !== 'background') return;
    const entry = this.active.get(operation.id);
    if (!entry || entry.binding || entry.context.controller.signal.aborted) throw new Error('Background proposal is no longer current');
    const scope = operation.scope;
    const binding: ExecutionJobBinding = { jobId: randomUUID(), operationId: operation.id, taskId: scope.taskId,
      hostId: scope.hostId, terminalId: scope.terminalId, terminalGeneration: scope.terminalGeneration,
      loginAs: scope.loginAs ?? scope.runAs, runAs: scope.runAs, connectionId };
    this.jobs.reserve(binding); entry.binding = binding;
  }

  started(operationId: string, event: { pid: number }): void {
    const entry = this.active.get(operationId);
    if (!entry?.binding || entry.context.controller.signal.aborted) throw new Error('Background startup recipient is no longer current');
    const job = this.jobs.started(entry.binding, event.pid);
    if (!['running', 'stop-requested'].includes(job.status)) throw new Error('Background startup observation is stale');
    entry.detached = true; entry.context.detached = true; entry.context.unlink();
    entry.ready(this.runningFeedback(job));
  }

  async interrupt(operation: ProposedOperation, send: () => Promise<'sent' | 'already-exited'>): Promise<OperationResult> {
    const control = operation.kind === 'command' ? operation.processControl : undefined;
    const entry = control && this.active.get(control.targetOperationId);
    const binding = entry?.binding, job = binding && this.jobs.get(binding.jobId);
    if (!control || !binding || !job || !entry?.detached || job.status !== 'running' || entry.context.controller.signal.aborted
      || control.jobId !== job.jobId || control.pid !== job.pid || control.processSequence !== job.processSequence
      || control.connectionId !== binding.connectionId || operation.scope.taskId !== binding.taskId
      || operation.scope.hostId !== binding.hostId || operation.scope.terminalId !== binding.terminalId
      || operation.scope.terminalGeneration !== binding.terminalGeneration)
      throw new Error('Background control binding changed; no signal sent');
    const receipt = { kind: 'interrupt' as const, jobId: job.jobId, targetOperationId: job.operationId };
    if (!this.jobs.beginStop(binding, operation.id).send) throw new Error('Stop already requested');
    try {
      const acknowledgement = send();
      // Signal submission precedes revoking the original action's future steps/authentication.
      // Aborting this lifetime does not itself signal or prove exit.
      entry.context.controller.abort();
      const delivery = await acknowledgement;
      return { operationId: operation.id, status: 'succeeded', effects: 'possible', processControl: { ...receipt, delivery },
        stdoutTail: '停止控制请求已确认；这不是目标进程退出或业务完成证明。请检查原任务状态和日志。' };
    } catch {
      this.jobs.unknown(binding, 'stop-delivery-unknown');
      return { operationId: operation.id, status: 'unknown', effects: 'possible',
        processControl: { ...receipt, delivery: 'unknown' }, stdoutTail: '停止请求结果未知；不会自动重发，请核验原任务。' };
    }
  }

  /** Transport exit can be later than interruption/tool settlement. */
  observe(result: OperationResult): void {
    const binding = this.active.get(result.operationId)?.binding;
    if (binding) this.jobs.observedResult(binding, result);
  }
  detached(operationId: string): boolean { return this.active.get(operationId)?.detached === true; }
  hasLease(terminalId: string): boolean {
    return [...this.active.values()].some((entry) => entry.detached && entry.binding?.terminalId === terminalId
      && !entry.context.controller.signal.aborted);
  }
  hasOperationLease(operation: ProposedOperation): boolean {
    const entry = this.active.get(operation.id), binding = entry?.binding, scope = operation.scope;
    return operation.kind === 'command' && operation.executionMode === 'background' && !!binding && entry!.detached
      && !entry!.context.controller.signal.aborted && binding.taskId === scope.taskId && binding.hostId === scope.hostId
      && binding.terminalId === scope.terminalId && binding.terminalGeneration === scope.terminalGeneration
      && binding.loginAs === (scope.loginAs ?? scope.runAs) && binding.runAs === scope.runAs;
  }
  get hasLive(): boolean { return this.active.size > 0; }
  get(jobId: string): ExecutionJobSnapshot | undefined { return this.jobs.get(jobId); }
  snapshot(): ExecutionJobSnapshot[] { return this.jobs.snapshot(); }
  restore(snapshots: readonly ExecutionJobSnapshot[]): void { this.jobs.restore(snapshots); }

  /** Disposes observation/leases only. No kill, reconnect, replay or claim of remote exit. */
  close(): void {
    this.closed = true;
    const errors: unknown[] = [];
    for (const entry of this.active.values()) {
      try { if (entry.binding) this.jobs.unknown(entry.binding, 'transport-lost'); } catch (error) { errors.push(error); }
      finally { entry.context.controller.abort(); entry.context.unlink(); }
    }
    if (errors.length) throw new Error('后台观察已关闭，但部分未知状态未能保存；必须核验原操作');
  }

  private async finish(id: string, entry: Active, dispatch: () => Promise<Feedback>): Promise<Feedback> {
    let completion: OperationResult['remoteCompletion'];
    try {
      const feedback = await dispatch();
      completion = feedback.result?.remoteCompletion;
      if (!entry.binding) return feedback;
      if (feedback.result) {
        if (completion && ['unknown', 'handed-over'].includes(feedback.result.status)
          && this.jobs.get(entry.binding.jobId)?.status === 'stop-requested') { /* Still observing the original process. */ }
        else if (operationOutcome(feedback.result).execution === 'not-started' && !entry.detached) this.jobs.notStarted(entry.binding, 'unsupported');
        else this.jobs.observedResult(entry.binding, feedback.result);
      } else if (!entry.detached) this.jobs.notStarted(entry.binding, 'denied');
      else this.jobs.unknown(entry.binding, 'transport-lost');
      return { ...feedback, structuredContent: { version: 1, executionJob: this.jobs.get(entry.binding.jobId) ?? null,
        operation: feedback.structuredContent ?? null, health: 'not-established', replay: 'never' },
        details: { ...(feedback.details && typeof feedback.details === 'object' ? feedback.details : {}),
        executionJob: this.jobs.get(entry.binding.jobId) } };
    } catch {
      if (entry.binding) this.jobs.unknown(entry.binding, 'transport-lost');
      return { content: [{ type: 'text', text: '后台执行未获得可靠完成结果；请核验原操作，不得自动重试。' }],
        details: { executionJob: entry.binding ? this.jobs.get(entry.binding.jobId) : undefined },
        structuredContent: { version: 1, executionJob: entry.binding ? this.jobs.get(entry.binding.jobId) ?? null : null,
          status: 'unknown', health: 'not-established', replay: 'never' }, isError: true };
    } finally {
      if (completion) void completion.then(() => this.release(id, entry), () => this.release(id, entry));
      else this.release(id, entry);
    }
  }
  private release(id: string, entry: Active): void {
    if (this.active.get(id) !== entry) return;
    this.active.delete(id); entry.context.operations.delete(id); this.cleanup(entry.context);
    if (!this.active.size) this.idle();
  }
  private cleanup(context: Context): void {
    if (!context.finished || context.operations.size) return;
    context.unlink(); this.contexts.delete(context.controller.signal);
  }
  private runningFeedback(job: ExecutionJobSnapshot): Feedback {
    return { content: [{ type: 'text', text: JSON.stringify({ executionJob: job,
      observation: 'Supervised process started; not proof of authentication, service health, or completion. Read its log/status; never replay to recover output.',
      replay: 'never' }) }], details: { executionJob: job },
      structuredContent: { version: 1, executionJob: job, health: 'not-established', replay: 'never' }, isError: false };
  }
}

/** Assemble the worker ledger from versioned operation JSON without any network access. */
export function createBackgroundOperations(taskId: string, prior: readonly OperationView[], operations: Map<string, OperationView>,
  publish: (operation: OperationView) => void, idle: () => void): BackgroundOperations {
  const runtime = new BackgroundOperations(taskId, (job) => {
    const operation = operations.get(job.operationId);
    if (!operation || operation.hostId !== job.hostId || operation.taskId !== job.taskId) throw new Error('Background operation record unavailable');
    operation.executionJob = job; publish(operation);
  }, idle);
  runtime.restore(prior.filter((op) => op.taskId === taskId && op.executionJob).map((op) => {
    const job = structuredClone(op.executionJob!);
    if (job.operationId !== op.id || job.hostId !== op.hostId || job.taskId !== op.taskId)
      throw new Error('Background recovery recipient mismatch');
    // Either ordered backend snapshot may have been persisted before the last projection.
    if (op.exitObserved && Number.isSafeInteger(op.exitCode) && op.exitCode! >= 0 && ['succeeded', 'failed'].includes(op.status)) {
      Object.assign(job, { status: op.exitCode === 0 ? 'exited' : 'failed', exitObserved: true, exitCode: op.exitCode, endedAt: op.completedAt });
    }
    return job;
  }));
  for (const job of runtime.snapshot()) {
    const operation = structuredClone(prior.find((op) => op.id === job.operationId && op.taskId === taskId)!);
    operation.executionJob = job;
    if (job.exitObserved) Object.assign(operation, { status: job.exitCode === 0 ? 'succeeded' : 'failed',
      exitObserved: true, exitCode: job.exitCode, completedAt: job.endedAt ?? operation.completedAt });
    else if (job.status === 'unknown' && !operation.exitObserved) operation.status = 'unknown';
    operations.set(operation.id, operation); publish(operation);
  }
  return runtime;
}
