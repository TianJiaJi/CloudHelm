import { analyzeOperationImpact, type CommandAnalyzer, type ProposedOperation } from '@cloudhelm/core';

/** Scheduling-order classification. It only affects queue structure and ordering:
 * authorization is re-derived by the SafetyGate at execution time, so a stale or
 * wrong class can never widen what a dispatch is allowed to do. */
export type OperationClass = 'read' | 'write';

/** Fail-closed pre-classification: only an analyzer-confirmed effect-free command
 * (or a structured read kind) schedules as a read; everything else, including
 * classification failures, schedules as a write. */
export async function classifyForScheduling(operation: ProposedOperation, analyzer: CommandAnalyzer): Promise<OperationClass> {
  if (operation.kind === 'inspect-file' || operation.kind === 'list-recovery') return 'read';
  if (operation.kind !== 'command') return 'write';
  try {
    return analyzeOperationImpact(operation, await analyzer.analyze(operation.command)).mutation === 'none' ? 'read' : 'write';
  } catch {
    return 'write';
  }
}

/** Concurrency domain. The terminal dimension is reserved for Phase 3
 * multi-terminal scheduling and is a constant today, so each task maps to one lane. */
export interface SchedulerKey {
  taskId: string;
  terminalId: string;
}

/** Per-lane concurrency budget. Phase 0 keeps every slot at 1, which reduces the
 * scheduler to strict serialCall semantics; enabling read concurrency changes
 * these limits only, never the structure. */
export interface SchedulerLimits {
  /** Hard in-flight cap for one key; 1 = strict serial. */
  total: number;
  /** Write slots per key; 1 keeps writes mutually exclusive. */
  writes: number;
  /** Read slots per key. */
  reads: number;
}

export const FULLY_SERIAL_LIMITS: SchedulerLimits = { total: 1, writes: 1, reads: 1 };

interface Entry {
  klass: OperationClass;
  ready: boolean;
  begin: () => void;
}

interface Lane {
  unstarted: Entry[];
  inFlight: number;
  writesInFlight: number;
  readsInFlight: number;
}

const newLane = (): Lane => ({ unstarted: [], inFlight: 0, writesInFlight: 0, readsInFlight: 0 });

/** Drop-in replacement for the task-runner serialCall chain with identical strict
 * FIFO semantics, plus the read/write classification data structures that the
 * concurrency switch (P0-3b) activates by changing limits only. */
export class OperationScheduler {
  private readonly lanes = new Map<string, Map<string, Lane>>();

  constructor(private readonly limits: SchedulerLimits = FULLY_SERIAL_LIMITS) {}

  run<T>(key: SchedulerKey, operation: ProposedOperation, analyzer: CommandAnalyzer, task: () => Promise<T>): Promise<T> {
    const lane = this.laneFor(key);
    // The queue position is reserved synchronously (serialCall chains at call
    // time), so classification latency can never reorder submissions.
    const entry: Entry = { klass: 'write', ready: false, begin: () => {} };
    const started = new Promise<void>((resolve) => { entry.begin = resolve; });
    lane.unstarted.push(entry);
    void classifyForScheduling(operation, analyzer).then((klass) => {
      entry.klass = klass;
      entry.ready = true;
      this.pump(lane);
    });
    this.pump(lane);
    return started.then(async () => {
      try {
        return await task();
      } finally {
        lane.inFlight--;
        if (entry.klass === 'write') lane.writesInFlight--; else lane.readsInFlight--;
        if (lane.unstarted.length === 0 && lane.inFlight === 0) this.lanes.get(key.taskId)?.delete(key.terminalId);
        this.pump(lane);
      }
    });
  }

  private laneFor(key: SchedulerKey): Lane {
    let byTerminal = this.lanes.get(key.taskId);
    if (!byTerminal) { byTerminal = new Map<string, Lane>(); this.lanes.set(key.taskId, byTerminal); }
    let lane = byTerminal.get(key.terminalId);
    if (!lane) { lane = newLane(); byTerminal.set(key.terminalId, lane); }
    return lane;
  }

  /** Strict lane FIFO: only the head entry may start, so a read can never jump
   * an earlier queued write; class slots then bound concurrency. */
  private pump(lane: Lane): void {
    for (;;) {
      const head = lane.unstarted[0];
      if (!head || !head.ready) break;
      const blocked = head.klass === 'write'
        ? lane.inFlight >= this.limits.total || lane.writesInFlight >= this.limits.writes
        : lane.inFlight >= this.limits.total || lane.readsInFlight >= this.limits.reads;
      if (blocked) break;
      lane.unstarted.shift();
      lane.inFlight++;
      if (head.klass === 'write') lane.writesInFlight++; else lane.readsInFlight++;
      head.begin();
    }
  }
}
