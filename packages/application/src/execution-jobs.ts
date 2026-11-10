import type { ExecutionJobBinding, ExecutionJobSnapshot, ExecutionJobUnknownReason, OperationResult } from '@cloudhelm/core';

const bindingKeys = ['jobId', 'operationId', 'taskId', 'hostId', 'terminalId', 'terminalGeneration', 'connectionId', 'loginAs', 'runAs'] as const;
const recipient = (value: ExecutionJobBinding): ExecutionJobBinding => ({
  jobId: value.jobId, operationId: value.operationId, taskId: value.taskId, hostId: value.hostId,
  terminalId: value.terminalId, terminalGeneration: value.terminalGeneration, connectionId: value.connectionId,
  loginAs: value.loginAs, runAs: value.runAs
});
const hasExit = (code: unknown): code is number => Number.isSafeInteger(code) && (code as number) >= 0;
const ended = (job: ExecutionJobSnapshot) => job.status === 'exited' || job.status === 'failed';

/** Backend lifecycle only. Callers supply transport observations, never model claims.
 * This ledger neither executes commands nor grants stop permission. persist must durably
 * save the detached snapshot before a new dispatch; exceptions propagate (fail closed).
 * Terminal results remain in the durable operation journal after runtime cache eviction. */
export class ExecutionJobs {
  private readonly jobs = new Map<string, ExecutionJobSnapshot>();
  constructor(private readonly taskId: string, private readonly persist: (job: ExecutionJobSnapshot) => void,
    private readonly maxTracked = 256, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(maxTracked) || maxTracked < 1 || maxTracked > 4096) throw new Error('Invalid execution job capacity');
  }

  reserve(binding: ExecutionJobBinding): ExecutionJobSnapshot {
    this.validateBinding(binding);
    if (this.jobs.has(binding.jobId) || [...this.jobs.values()].some((job) => job.operationId === binding.operationId)) {
      throw new Error('Execution job or operation already registered; do not replay');
    }
    const evict = this.jobs.size >= this.maxTracked ? [...this.jobs.values()].find(ended) : undefined;
    if (this.jobs.size >= this.maxTracked && !evict) throw new Error('Execution job capacity exhausted; inspect existing jobs');
    const at = this.now();
    const next: ExecutionJobSnapshot = { ...recipient(binding), version: 1, status: 'starting', createdAt: at, updatedAt: at,
      processSequence: 0, exitObserved: false };
    const saved = this.commit(next);
    if (evict) this.jobs.delete(evict.jobId);
    return saved;
  }

  started(binding: ExecutionJobBinding, pid: number): ExecutionJobSnapshot {
    const job = this.require(binding);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw new Error('Invalid observed process identity');
    // A stale start cannot undo lost observability, takeover, recovery, or an actual exit.
    if (ended(job) || job.status === 'unknown' || job.pid === pid) return structuredClone(job);
    const at = this.now();
    return this.commit({ ...job, pid, startedAt: job.startedAt ?? at, updatedAt: at,
      processSequence: job.processSequence + 1, status: job.stopRequestId ? 'stop-requested' : 'running' });
  }

  notStarted(binding: ExecutionJobBinding, reason: NonNullable<ExecutionJobSnapshot['notStarted']>): ExecutionJobSnapshot {
    const job = this.require(binding);
    if (ended(job)) return structuredClone(job);
    if (job.processSequence || job.status === 'unknown') throw new Error('Cannot assert not-started after possible execution');
    return this.commit({ ...job, status: 'failed', notStarted: reason, exitObserved: false, updatedAt: this.now() });
  }

  observedResult(binding: ExecutionJobBinding, result: OperationResult): ExecutionJobSnapshot {
    const job = this.require(binding);
    if (result.operationId !== job.operationId) throw new Error('Execution result recipient mismatch');
    if (ended(job)) return structuredClone(job);
    if (!['succeeded', 'failed'].includes(result.status) || !hasExit(result.exitCode)) return this.unknown(binding, 'transport-lost');
    const at = this.now();
    return this.commit({ ...job, status: result.exitCode === 0 ? 'exited' : 'failed', exitObserved: true,
      exitCode: result.exitCode, endedAt: at, updatedAt: at, unknownReason: undefined });
  }

  /** Records one stop intent BEFORE transport dispatch. send=true is not authorization;
   * the caller must still hold an exact SafetyGate/manual-control grant at dispatch. */
  beginStop(binding: ExecutionJobBinding, requestId: string): { job: ExecutionJobSnapshot; send: boolean } {
    const job = this.require(binding);
    if (!requestId || requestId.length > 128) throw new Error('Invalid stop request identity');
    if (ended(job) || job.stopRequestId) return { job: structuredClone(job), send: false };
    if (job.status === 'unknown') throw new Error('Cannot signal an unverified process; inspect the original operation');
    const at = this.now();
    return { job: this.commit({ ...job, status: 'stop-requested', stopRequestId: requestId,
      stopRequestedAt: at, updatedAt: at }), send: true };
  }

  unknown(binding: ExecutionJobBinding, reason: ExecutionJobUnknownReason): ExecutionJobSnapshot {
    const job = this.require(binding);
    if (ended(job)) return structuredClone(job);
    return this.commit({ ...job, status: 'unknown', unknownReason: reason, exitObserved: false,
      exitCode: undefined, endedAt: undefined, updatedAt: this.now() });
  }

  /** Offline restoration never connects, probes, resumes, signals, or replays a job. */
  restore(snapshots: readonly ExecutionJobSnapshot[]): void {
    if (this.jobs.size || snapshots.length > this.maxTracked) throw new Error('Invalid execution job restore');
    const restored = new Map<string, ExecutionJobSnapshot>(), operations = new Set<string>();
    for (const snapshot of snapshots) {
      this.validateBinding(snapshot);
      if (snapshot.version !== 1 || restored.has(snapshot.jobId) || operations.has(snapshot.operationId)) throw new Error('Invalid execution job history');
      if (!Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.updatedAt)
        || !Number.isSafeInteger(snapshot.processSequence) || snapshot.processSequence < 0) throw new Error('Invalid execution job observation');
      const job: ExecutionJobSnapshot = { ...recipient(snapshot), version: 1, status: snapshot.status,
        createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, processSequence: snapshot.processSequence,
        startedAt: Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : undefined,
        pid: Number.isInteger(snapshot.pid) && snapshot.pid! > 0 && snapshot.pid! <= 2147483647 ? snapshot.pid : undefined,
        exitObserved: snapshot.exitObserved === true, exitCode: snapshot.exitCode,
        endedAt: Number.isFinite(snapshot.endedAt) ? snapshot.endedAt : undefined,
        notStarted: snapshot.notStarted,
        stopRequestId: typeof snapshot.stopRequestId === 'string' && snapshot.stopRequestId.length <= 128 ? snapshot.stopRequestId : undefined,
        stopRequestedAt: Number.isFinite(snapshot.stopRequestedAt) ? snapshot.stopRequestedAt : undefined };
      const validExit = job.exitObserved && hasExit(job.exitCode)
        && job.status === (job.exitCode === 0 ? 'exited' : 'failed');
      const notStarted = job.status === 'failed' && job.processSequence === 0 && !job.exitObserved
        && ['denied', 'expired', 'unsupported', 'cancelled'].includes(job.notStarted ?? '');
      if (validExit) job.notStarted = undefined;
      if (!validExit && !notStarted) Object.assign(job, { status: 'unknown', unknownReason: 'recovered',
        exitObserved: false, exitCode: undefined, endedAt: undefined, notStarted: undefined, updatedAt: this.now() });
      restored.set(job.jobId, job); operations.add(job.operationId);
    }
    for (const [id, job] of restored) this.jobs.set(id, job);
  }

  get(jobId: string): ExecutionJobSnapshot | undefined {
    const job = this.jobs.get(jobId); return job ? structuredClone(job) : undefined;
  }
  snapshot(): ExecutionJobSnapshot[] { return [...this.jobs.values()].map((job) => structuredClone(job)); }

  private validateBinding(binding: ExecutionJobBinding): void {
    if (binding.taskId !== this.taskId || !Number.isSafeInteger(binding.terminalGeneration) || binding.terminalGeneration < 1
      || bindingKeys.some((key) => key !== 'terminalGeneration' && (typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 512))) {
      throw new Error('Invalid execution job binding');
    }
  }
  private require(binding: ExecutionJobBinding): ExecutionJobSnapshot {
    const job = this.jobs.get(binding.jobId);
    if (!job || bindingKeys.some((key) => job[key] !== binding[key])) throw new Error('Execution job binding changed');
    return job;
  }
  private commit(next: ExecutionJobSnapshot): ExecutionJobSnapshot {
    this.persist(structuredClone(next));
    this.jobs.set(next.jobId, structuredClone(next));
    return structuredClone(next);
  }
}
