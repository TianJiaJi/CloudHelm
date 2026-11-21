import { RequestBudgetError, type ConversationSession, type OperationResult, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { TerminalManager } from '@cloudhelm/application';
import type { AppEvent, OperationView, ResumeReason, TaskStatus, UserInterruption } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { ConversationTerminalPool } from '@cloudhelm/application';
import { buildRecoveryProbe, probeEvidence, recoveryProbeUnit, type ProbeEvidence } from './recovery-probe.js';
import { recoveryContextMessage } from './recovery-context.js';
import { interruptionContext } from './task-input-context.js';
import type { TaskRequestBudget } from './task-request-budget.js';

export interface RecoveryManagerDeps {
  hosts: RuntimeHost[];
  terminal: TerminalManager;
  terminalPool: ConversationTerminalPool;
  budget: TaskRequestBudget;
  agent(): ConversationSession | undefined;
  status(): TaskStatus;
  resumeReason(): ResumeReason | undefined;
  controlVersion(): number;
  operationViews(): OperationView[];
  bumpControlVersion(): number;
  setStatus(status: TaskStatus, summary?: string, resumeReason?: ResumeReason): void;
  blockRemote(reason: string, human?: boolean, resumeReason?: ResumeReason): void;
  clearRemoteBlocked(): void;
  resetProgress(): void;
  finishRun(): void;
  event(event: AppEvent): void;
  ensureTerminal(hostId: string): Promise<string>;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
  runRecoveryProbe(probe: ProposedOperation, signal?: AbortSignal): Promise<OperationResult | undefined>;
}

/** Owns recovery: explicit resume, interruption context and the needs-recovery flag. */
export class RecoveryManager {
  private resuming?: { version: number; promise: Promise<void> };
  private needsRecovery = false;
  private pending?: UserInterruption;

  constructor(private readonly deps: RecoveryManagerDeps) {}

  /** Whether the next turn must re-establish remote facts before continuing. */
  isRecoveryNeeded(): boolean { return this.needsRecovery; }

  markNeedsRecovery(): void { this.needsRecovery = true; }

  get pendingInterruption(): UserInterruption | undefined { return this.pending; }

  /** Records the authoritative user interruption the next round must acknowledge. */
  recordInterruption(interruption: UserInterruption): void { this.pending = interruption; }

  resume(): Promise<void> {
    if (this.deps.status() === 'waiting-user') return Promise.reject(new Error('请先回答问题或停止本轮对话'));
    if (this.resuming?.version === this.deps.controlVersion()) return this.resuming.promise;
    const reason = this.deps.resumeReason();
    if (!['paused', 'failed', 'human-control', 'recovering'].includes(this.deps.status())
      || !reason || reason === 'report') {
      return Promise.reject(new Error('没有可自动继续的未完成步骤，请明确发送下一步指令。'));
    }
    const version = this.deps.bumpControlVersion();
    const promise = this.resumeOnce(version, reason).catch((error: unknown) => {
      if (version !== this.deps.controlVersion()) return;
      if (error instanceof RequestBudgetError) throw error;
      if (this.deps.status() === 'paused' || this.deps.status() === 'human-control') return;
      // User stop or a SafetyGate block already published the authoritative pause; ignore Pi's late abort error.
      if (this.deps.status() === 'running') this.deps.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
      throw error;
    }).finally(() => {
      if (this.resuming?.version === version) this.resuming = undefined;
    });
    this.resuming = { version, promise };
    return promise;
  }

  /** Re-acquires agent terminals, then resumes the model with the recorded recovery reason. */
  private async resumeOnce(version: number, reason: ResumeReason): Promise<void> {
    const agent = this.deps.agent();
    if (!agent) return;
    await agent.waitForIdle();
    if (version !== this.deps.controlVersion()) return;
    await this.deps.budget.assertAvailable();
    if (version !== this.deps.controlVersion()) return;
    this.deps.setStatus('running');
    for (const { id: hostId } of this.deps.hosts) {
      const previous = this.deps.terminalPool.latest(hostId);
      if (!previous || this.deps.terminal.isAgentOwner(previous)) continue;
      const opened = await this.deps.terminalPool.acquire(hostId, () => {
        if (version !== this.deps.controlVersion()) throw new Error('对话控制状态已变化，终端未投入使用');
      });
      this.deps.event({ type: 'terminal-replaced', previousTerminalId: previous, terminalId: opened });
      if (!this.deps.terminal.isAgentOwner(opened)) {
        this.deps.blockRemote('终端状态已变化，请核验后继续。');
        return;
      }
    }
    this.deps.resetProgress();
    this.deps.clearRemoteBlocked();
    this.deps.setStatus('running');
    await this.appendInterruptionContext(agent);
    this.needsRecovery = false;
    const operations = this.deps.operationViews();
    await agent.resumeWithContext(recoveryContextMessage(operations, reason));
    if (this.deps.status() === 'running') this.deps.finishRun();
  }

  /** Recovery and interruption context the next continued turn must acknowledge first. */
  async recoveryPreamble(agent: ConversationSession): Promise<void> {
    if (this.needsRecovery) {
      await agent.context(recoveryContextMessage(this.deps.operationViews()));
      this.needsRecovery = false;
    }
    await this.appendInterruptionContext(agent);
  }

  private async appendInterruptionContext(agent: ConversationSession): Promise<void> {
    if (!this.pending) return;
    const interruption = this.pending;
    this.pending = undefined;
    await agent.context(interruptionContext(interruption, this.deps.operationViews()));
  }

  /** Automatic evidence collection after an unknown result: builds the whitelisted
   * read-only service probe only when a template applies, dispatches it through the
   * real pipeline on an independent lane, and returns bounded evidence only when the
   * probe itself observed a settled result. Any failure means undefined; the caller
   * then keeps the verbatim unknown pause fallback. */
  async probeUnknown(operation: ProposedOperation, signal?: AbortSignal): Promise<ProbeEvidence | undefined> {
    try {
      if (!recoveryProbeUnit(operation)) return undefined;
      const host = this.deps.hosts.find((candidate) => candidate.id === operation.scope.hostId);
      if (!host) return undefined;
      const terminalId = await this.deps.ensureTerminal(operation.scope.hostId);
      const probe = buildRecoveryProbe(operation, this.deps.scope(host, terminalId, operation.scope.cwd));
      if (!probe) return undefined;
      const observed = await this.deps.runRecoveryProbe(probe, signal);
      if (!observed || observed.status !== 'succeeded') return undefined;
      return probeEvidence(observed);
    } catch {
      return undefined;
    }
  }
}
