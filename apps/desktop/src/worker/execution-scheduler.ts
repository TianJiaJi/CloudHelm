import type { ConversationSession, DiagnosticEvent, ExecutionOptions, HostEnvironmentAccess, OperationAudit,
  OperationExecutor, OperationResult, OperationScope, ProposedOperation, SafetyDecision, ScriptInspector } from '@cloudhelm/core';
import { operationIntentKey, privilegeGuidance, redactOutput, safeDiagnostic } from '@cloudhelm/core';
import { ConversationTerminalPool, SafetyGate, type TerminalManager } from '@cloudhelm/application';
import type { BashAnalyzer } from '@cloudhelm/adapters';
import type { OperationView, ResumeReason, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { operationNeedsVerification, operationOutcomeResolvable } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { PROMPT_VERSION } from './agent-prompt.js';
import type { BackgroundOperations } from './background-operations.js';
import { commitOperationSnapshot } from './operation-commit-client.js';
import { blockedOperationFeedback, operationToolResult } from './operation-feedback.js';
import { operationPreview } from './operation-preview.js';
import { applyOperationDecision, applyOperationObservation } from './operation-observation.js';
import { runOperationPipeline } from './operation-retry.js';
import { CONVERSATION_LIMITS, OperationScheduler } from './operation-scheduler.js';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { appendProbeFindings, type ProbeEvidence } from './recovery-probe.js';
import { reviewCoordination } from './review-coordination.js';
import { applyCommittedRiskAcceptance } from './risk-acceptance.js';
import { mergeOperationViews } from './runtime-facts.js';
import { createTaskApprovals } from './task-approval.js';
import { createTaskRiskEvaluator } from './task-review-client.js';
import type { TaskReviewLifetime } from './task-review-lifetime.js';
import type { TaskSignals } from './task-signals.js';
import type { TaskProgress } from './task-progress.js';
import { reviewDeniedOperation } from './task-denial-review.js';
import type { VerificationRoundTracker } from './verification-round.js';
import { verificationSource } from './verification-source.js';
import type { WorkJournal } from './work-journal.js';

export interface ExecutionSchedulerDeps {
  task: TaskView;
  hosts: RuntimeHost[];
  terminal: TerminalManager;
  executor: OperationExecutor;
  analyzer: BashAnalyzer;
  scripts?: ScriptInspector;
  signals: TaskSignals;
  privileged?: PrivilegedTaskAccess;
  environment?: HostEnvironmentAccess;
  priorOperations: readonly OperationView[];
  progress: TaskProgress;
  terminalPool: ConversationTerminalPool;
  reviews: TaskReviewLifetime;
  journal(): WorkJournal;
  verification(): VerificationRoundTracker;
  background(): BackgroundOperations;
  profile(): RuntimeProfile;
  status(): TaskStatus;
  remoteBlocked(): string | undefined;
  isRunning(): boolean;
  agent(): ConversationSession | undefined;
  controlVersion(): number;
  requestGeneration(): string;
  assertRemoteActive(): void;
  setStatus(status: TaskStatus, summary?: string, resumeReason?: ResumeReason): void;
  blockRemote(reason: string, human?: boolean, resumeReason?: ResumeReason): void;
  probeUnknown?(operation: ProposedOperation, signal?: AbortSignal): Promise<ProbeEvidence | undefined>;
  finishRun(): void;
  publishExecution(): void;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
}

/** Owns operation execution: dispatch pipelines, gates, operation views and review coordination. */
export class ExecutionScheduler {
  private readonly operations = new Map<string, OperationView>();
  private readonly proposedOperations = new Map<string, ProposedOperation>();
  private readonly replayProtected = new Set<string>();
  private consecutiveAiDenials = 0;
  private readonly aiDeniedOperations = new Map<string, ProposedOperation>();
  private readonly manualReviewsInFlight = new Set<string>();
  private lastFailureKey = '';
  private sameFailureCount = 0;
  /** Writes stay mutually exclusive per task; analyzer-confirmed read pipelines may run up to four at once. */
  private readonly scheduler = new OperationScheduler(CONVERSATION_LIMITS);

  constructor(private readonly deps: ExecutionSchedulerDeps) {
    for (const operation of deps.priorOperations) this.replayProtected.add(operation.id);
  }

  get operationRecords(): Map<string, OperationView> { return this.operations; }

  operationViews(): OperationView[] {
    return mergeOperationViews([...this.deps.priorOperations, ...this.operations.values()]);
  }

  setOperation(operation: OperationView): void { this.operations.set(operation.id, operation); }

  hasOperation(id: string): boolean { return this.operations.has(id); }

  getOperation(id: string): OperationView | undefined { return this.operations.get(id); }

  operationsSnapshot(): OperationView[] { return [...this.operations.values()]; }

  /** Clears replay protection when a prior conversation's outcomes have been reconciled. */
  releaseReplayProtection(): void { this.replayProtected.clear(); }

  runOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined, hostLabel: string, manualReview = false,
    onFileInspection?: ExecutionOptions['onFileInspection']) {
    return this.scheduler.run({ taskId: this.deps.task.id, terminalId: 'conversation' },
      operation, this.deps.analyzer, () => this.deps.background().run(operation, signal,
        () => this.performOperation(gate, operation, signal, hostLabel, manualReview, onFileInspection)));
  }

  private async performOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined,
    hostLabel: string, manualReview = false, onFileInspection?: ExecutionOptions['onFileInspection']) {
    this.deps.assertRemoteActive();
    const final = await runOperationPipeline({ gate, signal, manualReview,
      preflight: { privileged: this.deps.privileged, analyzer: this.deps.analyzer, environment: this.deps.environment,
        operations: () => this.operationViews(), replayProtected: this.replayProtected, hostBlocked: (hostId) => this.pendingOutcomeBlocker(hostId) },
      gateObserver: (candidate) => candidate.kind === 'command' && candidate.executionMode === 'background'
        ? { onProcessStarted: (event) => this.deps.background().started(candidate.id, event) } : { onFileInspection },
      coordinateDecision: (decision) => this.coordinateDecision(decision),
      onRetry: (previousOperationId, nextAttempt) => this.diagnostic({ event: 'operation.retry', operationId: previousOperationId,
        attempt: nextAttempt, failureKind: 'not-dispatched', hostId: operation.scope.hostId })
    }, operation);
    if ('feedback' in final) return final.feedback;
    operation = final.operation;
    const outcome = final.outcome;
    const result = outcome.result!;
    if (this.deps.background().detached(operation.id) || operation.kind === 'command' && operation.processControl) return operationToolResult(result, hostLabel, outcome.readOnly, operation.scope);
    if (result.requiresUserAction) {
      this.deps.blockRemote(result.privilege ? privilegeGuidance(result.privilege) : '认证未通过或当前认证形式需要人工接管，已暂停。请处理后手动继续，AI 不会自动改换方式重试。', false, 'interrupted');
    } else if (result.status === 'handed-over') {
      this.deps.blockRemote('终端已转为人工输入；请核验结果后发送消息继续。');
    } else if (result.status === 'unknown') {
      const findings = await this.deps.probeUnknown?.(operation, signal);
      if (findings) return appendProbeFindings(operationToolResult(result, hostLabel, outcome.readOnly, operation.scope), findings);
      this.deps.blockRemote('远端操作结果未知，已暂停。请先核验，避免重复执行。', false, 'verify');
    } else if (!this.deps.terminal.isAgentOwner(operation.scope.terminalId)) {
      this.deps.blockRemote('远端终端已暂停或被接管，请核验后手动继续。');
    } else if (result.status === 'failed' && result.effects === 'possible' && outcome.readOnly !== true) {
      this.deps.blockRemote('操作失败且可能已产生部分变更。已暂停，请先核验原结果，再决定后续操作。', false, 'verify');
    } else if (result.status === 'failed') {
      const key = `${operation.scope.hostId}:${this.preview(operation)}:${result.exitCode ?? 'unknown'}`;
      this.sameFailureCount = key === this.lastFailureKey ? this.sameFailureCount + 1 : 1;
      this.lastFailureKey = key;
      if (this.sameFailureCount >= 3) {
        this.deps.setStatus('paused', 'The same operation failed three consecutive times');
        this.deps.agent()?.abort();
      }
    } else if (result.status === 'succeeded') {
      this.deps.progress.observe('operation', JSON.stringify([operationIntentKey(operation), result.stdoutTail, result.exitCode, result.effects]));
      this.sameFailureCount = 0;
      this.lastFailureKey = '';
    }
    return operationToolResult(result, hostLabel, outcome.readOnly, operation.scope);
  }

  /** Whitelisted read-only recovery probe dispatched on its own scheduler lane, so a
   * busy conversation lane can never deadlock evidence collection after unknown results. */
  async runRecoveryProbe(probe: ProposedOperation, signal?: AbortSignal): Promise<OperationResult | undefined> {
    this.deps.assertRemoteActive();
    const feedback = await this.scheduler.run({ taskId: this.deps.task.id, terminalId: 'recovery-probe' },
      probe, this.deps.analyzer, () => this.deps.background().run(probe, signal,
        () => this.performRecoveryProbe(probe, signal)));
    return feedback.result !== undefined && feedback.result.status !== 'unknown' ? feedback.result : undefined;
  }

  private async performRecoveryProbe(probe: ProposedOperation, signal: AbortSignal | undefined) {
    const final = await runOperationPipeline({ gate: this.createGate(), signal, manualReview: false,
      preflight: { privileged: this.deps.privileged, analyzer: this.deps.analyzer, environment: this.deps.environment,
        operations: () => this.operationViews(), replayProtected: this.replayProtected, hostBlocked: (hostId) => this.pendingOutcomeBlocker(hostId) },
      gateObserver: () => ({}),
      coordinateDecision: () => {},
      onRetry: (previousOperationId, nextAttempt) => this.diagnostic({ event: 'operation.retry', operationId: previousOperationId,
        attempt: nextAttempt, failureKind: 'not-dispatched', hostId: probe.scope.hostId })
    }, probe);
    if ('feedback' in final) return final.feedback;
    const result = final.outcome.result;
    if (!result) return blockedOperationFeedback(final.operation.id, 'probe-unobserved',
      'SafetyGate returned no observed result for the recovery probe.');
    return operationToolResult(result, this.hostLabel(final.operation), final.outcome.readOnly, final.operation.scope);
  }

  private hostLabel(operation: ProposedOperation): string {
    return this.deps.hosts.find((host) => host.id === operation.scope.hostId)?.label ?? operation.scope.hostId;
  }

  /** Same fact the host write lock uses, checked before an approval card or AI review. */
  private pendingOutcomeBlocker(hostId: string): string | undefined {
    const unresolved = this.operationViews().find((operation) => operation.hostId === hostId && operationNeedsVerification(operation));
    return unresolved
      ? `A previous operation on this host (${unresolved.id}, ${unresolved.status}) still has an unresolved remote outcome; writes are locked until it is verified.`
      : undefined;
  }

  /** Round-level coordination for one review outcome; never a side effect of the audit record. */
  private coordinateDecision(decision: SafetyDecision): void {
    if (decision.ruleId === 'ai-review-deny' && this.consecutiveAiDenials >= 3) {
      this.deps.blockRemote('独立审核连续拒绝三次，已暂停以避免反复试探。请检查目标或人工处理。');
      return;
    }
    if (reviewCoordination(decision) === 'pause-round') {
      this.deps.blockRemote(`操作未执行，审核未放行（${decision.ruleId}）：${decision.reason}。已暂停，请处理后手动继续。`);
    }
  }

  createGate(executor: OperationExecutor = this.deps.executor): SafetyGate {
    const audit: OperationAudit = {
      proposed: async (operation) => {
        this.diagnostic({ event: 'operation.proposed', hostId: operation.scope.hostId, operationId: operation.id,
          runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, sessionId: operation.scope.sessionId, cwd: operation.scope.cwd, policyRevision: operation.scope.policyRevision });
        this.proposedOperations.set(operation.id, operation);
        this.updateOperation(operation, 'proposed', await verificationSource(operation, this.deps.analyzer));
        if (operation.kind === 'command' && operation.executionMode === 'background') {
          const connectionId = operation.scope.sessionId ? `privileged:${operation.scope.sessionId}`
            : this.deps.terminalPool.snapshot().find((entry) => entry.terminalId === operation.scope.terminalId)?.connectionId;
          if (!connectionId) throw new Error('Background connection binding unavailable');
          this.deps.background().proposed(operation, connectionId);
        }
        await commitOperationSnapshot(this.operations.get(operation.id), this.deps.signals.commitOperation);
      },
      classified: async (id, readOnly, impact) => {
        const view = this.operations.get(id);
        if (!view) return;
        view.readOnly = readOnly; view.impactAnalysis = impact;
        this.deps.signals.event({ type: 'operation', value: view });
      },
      decided: async (id, decision) => {
        this.diagnostic({ event: 'review.result', operationId: id, status: decision.verdict, ruleId: decision.ruleId });
        const view = this.operations.get(id);
        if (view) {
          applyOperationDecision(view, decision, this.consecutiveAiDenials);
          this.deps.signals.event({ type: 'operation', value: view });
        }
        await commitOperationSnapshot(this.operations.get(id), this.deps.signals.commitOperation);
        if (decision.ruleId === 'ai-review-deny') {
          const proposed = this.proposedOperations.get(id);
          if (proposed) this.aiDeniedOperations.set(id, proposed);
          this.consecutiveAiDenials++;
        } else if (decision.verdict === 'allow') {
          this.consecutiveAiDenials = 0;
          this.aiDeniedOperations.delete(id);
        }
        // Round control belongs to coordinateDecision after the durable decision,
        // not this audit callback (which must not pause correctable stale reviews).
      },
      completed: async (result) => {
        this.proposedOperations.delete(result.operationId);
        const operation = this.operations.get(result.operationId);
        if (!operation) return;
        applyOperationObservation(operation, result);
        if (operation.kind !== 'command' && result.stdoutTail) operation.reason = redactOutput(result.stdoutTail).slice(-2000);
        this.deps.signals.event({ type: 'operation', value: operation });
        await commitOperationSnapshot(operation, this.deps.signals.commitOperation);
        this.deps.verification().pending(this.deps.task.id, operation, this.operationViews());
        if (!this.deps.isRunning()) this.deps.journal().finalize(this.deps.verification().id);
        this.deps.publishExecution();
      }
    };
    return new SafetyGate({
      analyzer: this.deps.analyzer,
      scripts: this.deps.scripts,
      reviewSignal: () => this.deps.reviews.signal(),
      evaluator: createTaskRiskEvaluator(this.deps.task.id, this.deps.signals.budget, () => this.deps.assertRemoteActive(),
        () => this.deps.requestGeneration(), () => this.deps.profile(),
      () => this.operationViews().slice(-5).map((item) => `${item.kind} ${item.status}: ${item.kind === 'command' ? redactOutput(item.preview).slice(0, 400) : item.preview.split('\n')[0]}`), (event) => this.diagnostic(event)),
      approvals: createTaskApprovals(this.deps.signals, (operation) => this.preview(operation),
        () => this.deps.setStatus('waiting-review'), () => { if (this.deps.status() === 'waiting-review') this.deps.setStatus('running'); }),
      executor, audit, lease: {
        currentGeneration: (id) => this.deps.terminal.currentGeneration(id),
        isAgentOwner: (id) => this.deps.terminal.isAgentOwner(id)
      },
      isOperationActive: (operation) => (!this.deps.remoteBlocked() && ['running', 'waiting-review'].includes(this.deps.status()))
        || this.deps.background().hasOperationLease(operation),
      settings: (hostId) => ({ mode: this.deps.task.reviewModesByHost?.[hostId]
        ?? this.deps.hosts.find((host) => host.id === hostId)?.defaultMode ?? 'ask',
        revision: this.deps.hosts.find((host) => host.id === hostId)?.policyRevision ?? -1,
        conversationRevision: this.deps.task.reviewRevision ?? 1,
        reviewerRevision: this.deps.profile().reviewer?.revision ?? 1 })
    });
  }

  private updateOperation(operation: ProposedOperation, status: OperationView['status'], source?: OperationView['verificationSource']): void {
    this.deps.verification().record(this.deps.task.id, operation.id);
    const connectionId = operation.scope.sessionId ? `privileged:${operation.scope.sessionId}`
      : this.deps.environment?.snapshot(operation.scope.hostId, operation.scope.loginAs ?? operation.scope.runAs).connectionId;
    const view: OperationView = {
      ...(connectionId ? { executionContext: { version: 1, connectionId, terminalId: operation.scope.terminalId,
        terminalGeneration: operation.scope.terminalGeneration } } : {}),
      ...(operation.kind === 'command' && operation.processControl ? { processControl: { ...operation.processControl } } : {}),
      ...(operation.kind === 'command' && operation.probe ? { internal: operation.probe === 'recovery' ? 'recovery-probe' as const
        : 'identity-probe' as const, ...(operation.probe === 'recovery' && operation.recoveryTarget
          ? { recoveryProbeTarget: operation.recoveryTarget } : {}) } : {}),
      ...(operation.kind === 'command' && operation.executionChannel ? { executionChannel: operation.executionChannel } : {}),
      delegationId: operation.delegationId, toolCallId: operation.toolCallId,
      verificationSource: source,
      outputExpectation: operation.kind === 'command' ? operation.outputExpectation : undefined,
      serviceUnit: operation.kind === 'command' ? operation.serviceUnit : undefined,
      commandSource: operation.kind === 'command' && redactOutput(operation.scope.cwd) === operation.scope.cwd
        ? { version: 1, cwd: operation.scope.cwd } : undefined,
      intentKey: operationIntentKey(operation), id: operation.id, taskId: this.deps.task.id, hostId: operation.scope.hostId, kind: operation.kind,
      promptVersion: PROMPT_VERSION,
      preview: this.preview(operation), status, runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, logRef: operation.scope.terminalId,
      model: { provider: this.deps.profile().provider, modelId: this.deps.profile().modelId }, createdAt: Date.now()
    };
    this.replayProtected.add(operation.id);
    this.operations.set(operation.id, view);
    this.deps.signals.event({ type: 'operation', value: view });
  }

  recordRemoteResult(result: OperationResult): void {
    this.deps.background().observe(result);
    const operation = this.operations.get(result.operationId);
    if (!operation) return;
    applyOperationObservation(operation, result);
    this.deps.signals.event({ type: 'operation', value: operation });
    this.deps.verification().pending(this.deps.task.id, operation, this.operationViews());
    this.deps.publishExecution();
    if (this.deps.status() === 'answered') this.deps.finishRun();
    else if (!this.deps.isRunning()) this.deps.journal().finalize(this.deps.verification().id);
    // A finished operation never converts its terminal into a human shell by itself;
    // only the user typing (or an explicit takeover request) does that.
  }

  /** Cross-conversation recovery resolves outcomes this task may have created earlier. */
  assertResolvableOutcome(operationId: string): void {
    const operation = this.operationViews().find((item) => item.id === operationId);
    if (operation && !operationOutcomeResolvable(operation)) throw new Error('该操作仍在执行或已核验，不能重复确认风险');
  }

  /** Applies a user risk acceptance without ever claiming an observed outcome. */
  recordRiskAcceptance(accepted: OperationView): void {
    if (accepted.taskId !== this.deps.task.id) return;
    const operation = this.operationViews().find((item) => item.id === accepted.id);
    if (!operation) return;
    this.operations.set(operation.id, applyCommittedRiskAcceptance(operation, accepted));
    this.deps.progress.observe('resolution', JSON.stringify([operation.id, accepted.reconciliation?.kind]));
    if (this.deps.status() === 'answered') this.deps.finishRun();
    else this.deps.journal().finalize(this.deps.verification().id);
    this.deps.publishExecution();
  }

  async requestAiDenialReview(operationId: string): Promise<void> {
    await reviewDeniedOperation(operationId, { task: this.deps.task, hosts: this.deps.hosts, agent: this.deps.agent(), terminal: this.deps.terminal,
      pool: this.deps.terminalPool, operations: this.operations, denied: this.aiDeniedOperations, inFlight: this.manualReviewsInFlight,
      version: () => this.deps.controlVersion(), blocked: () => !!this.deps.remoteBlocked(), reviewerRevision: () => this.deps.profile().reviewer?.revision ?? 1,
      scope: (host, id, cwd) => this.deps.scope(host, id, cwd), event: this.deps.signals.event,
      start: () => this.deps.setStatus('running'), finish: () => { if (this.deps.status() === 'running') this.deps.setStatus('paused', '人工复核已结束，请核验这次操作的实际结果'); },
      execute: (operation, label) => this.runOperation(this.createGate(), operation, undefined, label, true) });
  }

  private diagnostic(event: DiagnosticEvent): void {
    this.deps.signals.diagnostic?.(safeDiagnostic({ ...event, taskId: this.deps.task.id }));
  }

  private preview(operation: ProposedOperation): string { return operationPreview(operation); }
}
