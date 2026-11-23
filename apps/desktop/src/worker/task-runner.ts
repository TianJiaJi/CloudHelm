import type { ConversationInput, ConversationInputKind, ExecutionTerminalBinding, HostEnvironmentAccess } from '@cloudhelm/core';
import { createAuditedRemoteReader } from './audited-remote-read.js';
import { createBackgroundJobTool } from './background-job-tool.js';
import { createBackgroundOperations, type BackgroundOperations } from './background-operations.js';
import { createWorkspaceContextTools } from './workspace-context.js';
import { decideTaskCompletion } from './task-completion.js';
import { VerificationRoundTracker } from './verification-round.js';
import { randomUUID } from 'node:crypto';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { ConversationTerminalPool, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, createConversationSession } from '@cloudhelm/adapters';
import { needsTaskReviewer, resolveTaskReviewer } from './task-review-client.js';
import { TaskReviewLifetime } from './task-review-lifetime.js';
import { taskSessionEvents } from './task-session-events.js';
import type { TaskSignals } from './task-signals.js';
import { TaskRequestBudget, budgetPauseNotice } from './task-request-budget.js';
import { taskPreparation, type PreparationSnapshot } from './task-preparation.js';
import { taskContextSnapshot } from './task-context.js';
import { TaskProgress } from './task-progress.js';
import { observeProgressTools } from './task-progress-observer.js';
import { RequestBudgetError, PrivilegeError, privilegeGuidance, safeDiagnostic, type ConversationSession, type SessionStorage, type DiagnosticEvent, type OperationResult, type OperationExecutor, type OperationScope, type ScriptInspector } from '@cloudhelm/core';
import type { LocalScope, OperationView, InterruptionSource, UserInterruption, PreauthorizationScope, ReviewMode, ResumeReason, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { isActiveTaskStatus } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { deriveInputIntent } from './task-intent.js';
import { ExecutionScheduler } from './execution-scheduler.js';
import { IntentManager } from './intent-manager.js';
import { RecoveryManager } from './recovery-manager.js';
import { createRemoteTools } from './remote-tools.js';
import { createTaskPrompt } from './task-prompt.js';
import { WorkJournal } from './work-journal.js';
import { LocalFileAccess } from './local-file-access.js';
import { LogicalContextTracker, createSetDefaultCwdTool } from './logical-context.js';

export class TaskRunner {
  private profile: RuntimeProfile;
  private readonly journal: WorkJournal;
  private readonly verification: VerificationRoundTracker;
  private controlVersion = 0;
  private readonly intents: IntentManager;
  private readonly execution: ExecutionScheduler;
  private readonly recovery: RecoveryManager;
  private readonly localFiles: LocalFileAccess;
  private readonly analyzer = new BashAnalyzer();
  private readonly reviews = new TaskReviewLifetime();
  private agent?: ConversationSession;
  private readonly budget: TaskRequestBudget;
  private requestCount = 0;
  private requestStarted = 0;
  private readonly progress = new TaskProgress();
  private remoteBlocked?: string;
  private readonly terminalPool: ConversationTerminalPool;
  private readonly background: BackgroundOperations;
  private stopping = false;
  private status: TaskStatus = 'draft';
  private resumeReason?: ResumeReason;
  private readonly logicalContexts: LogicalContextTracker;

  constructor(
    readonly task: TaskView,
    private readonly hosts: RuntimeHost[],
    profile: RuntimeProfile,
    private readonly priorOperations: OperationView[],
    private readonly terminal: TerminalManager,
    private readonly executor: OperationExecutor,
    openTerminal: (hostId: string, taskId: string, binding: ExecutionTerminalBinding) => Promise<string>,
    private readonly signals: TaskSignals,
    private readonly readLog: (operationId: string, cursor: number) => Promise<{ text: string; nextCursor: number; more: boolean }> = async () => ({ text: '', nextCursor: 0, more: false }),
    private readonly privileged?: PrivilegedTaskAccess,
    private readonly storage?: SessionStorage,
    private readonly scripts?: ScriptInspector,
    private readonly environment?: HostEnvironmentAccess,
    priorInputs: readonly ConversationInput[] = [],
    private readonly readRemoteFile?: (hostId: string, path: string, cwd: string | undefined, signal?: AbortSignal, maxBytes?: number) => Promise<import('./remote-tool-dependencies.js').RemoteFileSnapshot>,
    private readonly verifyDefaultCwd?: (hostId: string, path: string) => Promise<{ canonical: string } | { failed: true }>
  ) {
    const unobservedConnection = randomUUID();
    this.terminalPool = new ConversationTerminalPool(task.id, terminal, openTerminal, (hostId) => {
      const host = this.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Host is outside this conversation');
      return { hostId, loginAs: host.username,
        connectionId: this.environment?.snapshot(hostId, host.username).connectionId ?? unobservedConnection };
    });
    this.logicalContexts = new LogicalContextTracker(task.logicalContexts,
      (value) => signals.event({ type: 'logical-context', taskId: task.id, value }));
    this.execution = new ExecutionScheduler({
      task, hosts: this.hosts, terminal, executor, analyzer: this.analyzer, scripts,
      signals, privileged: this.privileged, environment: this.environment,
      priorOperations, progress: this.progress, terminalPool: this.terminalPool,
      reviews: this.reviews,
      journal: () => this.journal,
      verification: () => this.verification,
      background: () => this.background,
      profile: () => this.profile,
      status: () => this.status,
      remoteBlocked: () => this.remoteBlocked,
      isRunning: () => this.isRunning(),
      agent: () => this.agent,
      controlVersion: () => this.controlVersion,
      requestGeneration: () => this.requestGeneration(),
      assertRemoteActive: () => this.assertRemoteActive(),
      setStatus: (status, summary, resumeReason) => this.setStatus(status, summary, resumeReason),
      blockRemote: (reason, human, resumeReason) => this.blockRemote(reason, human, resumeReason),
      probeUnknown: (operation, signal) => this.recovery.probeUnknown(operation, signal),
      finishRun: () => this.finishRun(),
      publishExecution: () => this.publishExecution(),
      scope: (host, terminalId, cwd) => this.scope(host, terminalId, cwd),
      logicalContext: (hostId) => this.logicalContexts.receiptContext(hostId)
    });
    this.background = createBackgroundOperations(task.id, priorOperations, this.execution.operationRecords,
      (operation) => signals.event({ type: 'operation', value: operation }), () => { if (!this.isRunning()) this.privileged?.close(); });
    // Legacy report bookkeeping is not an instruction to resume model/remote work.
    this.resumeReason = task.resumeReason === 'report' ? undefined : task.resumeReason;
    this.verification = new VerificationRoundTracker(task, this.operationViews(), signals.event);
    this.intents = new IntentManager(task, this.hosts, this.environment, signals, priorInputs, {
      agent: () => this.agent,
      profile: () => this.profile,
      status: () => this.status,
      remoteBlocked: () => this.remoteBlocked,
      resumeReason: () => this.resumeReason,
      operationViews: () => this.operationViews(),
      verificationClosed: () => this.verification.closed,
      roundOperations: () => this.verification.operations(this.operationViews()),
      completionReportVerified: () => this.journal.completionReport().reportStatus === 'verified'
    }, {
      assertRemoteActive: () => this.assertRemoteActive(),
      blockRemote: (reason, human, resumeReason) => this.blockRemote(reason, human, resumeReason),
      setStatus: (status, summary, resumeReason) => this.setStatus(status, summary, resumeReason),
      bumpControlVersion: () => { this.controlVersion++; },
      markNeedsRecovery: () => this.recovery.markNeedsRecovery(),
      releaseReplayProtection: () => { this.execution.releaseReplayProtection(); },
      clearRemoteBlocked: () => this.clearRemoteBlock(),
      resetReport: () => { this.journal.resetReport(); this.signals.event({ type: 'verification-state', taskId: this.task.id }); },
      resetProgress: () => { this.progress.reset(); },
      observeProgress: (kind, key) => { this.progress.observe(kind, key); },
      beginVerificationRound: (taskId) => { this.verification.begin(taskId); },
      preparationSnapshot: (scopes, pendingIntent) => this.preparationSnapshot(scopes, pendingIntent),
      continueWithMessage: (agent, text, document) => { void this.continueWithMessage(agent, text, document); },
      abortAgent: () => { this.agent?.abort(); }
    });
    this.profile = profile;
    this.requestCount = task.requestCount;
    this.budget = new TaskRequestBudget(task.id, signals.budget);
    this.recovery = new RecoveryManager({
      hosts: this.hosts, terminal, terminalPool: this.terminalPool, budget: this.budget,
      agent: () => this.agent,
      status: () => this.status,
      resumeReason: () => this.resumeReason,
      controlVersion: () => this.controlVersion,
      operationViews: () => this.operationViews(),
      bumpControlVersion: () => ++this.controlVersion,
      setStatus: (status, summary, resumeReason) => this.setStatus(status, summary, resumeReason),
      blockRemote: (reason, human, resumeReason) => this.blockRemote(reason, human, resumeReason),
      clearRemoteBlocked: () => this.clearRemoteBlock(),
      resetProgress: () => { this.progress.reset(); },
      finishRun: () => this.finishRun(),
      event: (event) => this.signals.event(event),
      ensureTerminal: (hostId) => this.ensureTerminal(hostId),
      scope: (host, terminalId, cwd) => this.scope(host, terminalId, cwd),
      runRecoveryProbe: (probe, signal) => this.execution.runRecoveryProbe(probe, signal)
    });
    this.journal = new WorkJournal(task.id, () => this.operationViews(), signals.event, this.readLog,
      (operation) => this.executor.reconcile?.(operation.hostId, operation.id) ?? false, (operation) => {
      this.execution.setOperation(operation);
      this.progress.observe('resolution', JSON.stringify([operation.id, operation.reconciliation?.kind]));
      this.signals.event({ type: 'operation', value: operation });
      this.publishExecution();
    }, () => this.verificationOperations(), () => this.verification.id, task.report);
    this.localFiles = new LocalFileAccess(task.localScopes ?? []);
  }

  private async initializeSession(thinkingLevel?: import('@cloudhelm/core').ThinkingLevel): Promise<void> {
    const gate = this.execution.createGate();
    const remoteTools = createRemoteTools({ hosts: this.hosts, localFiles: this.localFiles,
      taskId: this.task.id, controlledFiles: this.executor.supportsFileTransactions, fileBinding: () => this.requestGeneration(), fileOperations: () => this.operationViews(),
      refused: (tool, code) => this.diagnostic({ event: 'tool.refused', tool, errorCode: code }),
      background: (signal, run) => this.background.withLifetime(signal, run),
      ensureTerminal: async (id, sessionId) => {
        this.assertRemoteActive();
        if (sessionId) {
          if (!this.privileged) throw new Error('Root sessions unavailable');
          return this.privileged.terminal(sessionId, id);
        }
        return this.ensureTerminal(id);
      },
      requestRoot: async (host, command, cwd, reason, signal, method) => {
        this.assertRemoteActive();
        if (!this.privileged) throw new Error('Root sessions unavailable');
        try { return await this.privileged.request(host, command, cwd, reason, this.intents.goal(), gate, signal, this.intents.snapshot(), method); }
        catch (error) { this.blockRemote(error instanceof PrivilegeError ? privilegeGuidance(error.feedback) : '提权上下文未建立；直接su通常需要root密码而非sudo密码。请处理后点击继续AI或明确发送下一步指令。', false, 'interrupted'); throw error; }
      }, scope: (host, id, cwd) => this.scope(host, id, cwd),
      readRemoteFile: createAuditedRemoteReader(this.task.id, this.hosts, this.readRemoteFile,
        this.signals, () => this.assertRemoteActive(), this.execution.operationRecords),
      runOperation: (gate, operation, signal, label, onFileInspection) => this.execution.runOperation(gate, operation, signal, label, false, onFileInspection) }, gate);
    const currentSystemPrompt = createTaskPrompt(this.task, this.hosts, () => this.operationViews(), () => this.verificationOperations(), this.privileged, () => this.journal.hasReport(), () => this.intents.snapshot(), () => this.journal.submissionClosed(), this.environment);
    this.agent = await createConversationSession({
      thinkingLevel, profile: this.profile, storage: this.storage,
      inputSelected: (input) => this.intents.inputSelected(input), inputDelivered: (id, entryId) => this.intents.inputDelivered(id, entryId),
      inputHistoryAllowed: (id) => this.intents.inputHistoryAllowed(id),
      queryReferenceAllowed: (id) => this.execution.hasOperation(id) || this.hosts.some((host) => host.id === id)
        || this.terminalPool.owns(id) || this.execution.operationsSnapshot().some((op) => op.executionJob?.jobId === id),
      systemPrompt: currentSystemPrompt(), currentSystemPrompt,
      tools: observeProgressTools([...remoteTools, createSetDefaultCwdTool({ hosts: this.hosts,
        verify: this.verifyDefaultCwd ? (hostId, path) => this.verifyDefaultCwd!(hostId, path) : undefined,
        apply: (hostId, loginAs, canonical) => this.logicalContexts.setExplicit(hostId, loginAs, canonical, () => this.reviews.invalidate()),
        assertActive: () => this.assertRemoteActive() }),
        createBackgroundJobTool({ background: this.background, terminal: this.terminal,
        executor: this.executor, hosts: this.hosts, operations: () => this.operationViews(), assertActive: () => this.assertRemoteActive(),
        scope: (host, id, cwd) => this.scope(host, id, cwd), runOperation: (gate, operation, signal, label) => this.execution.runOperation(gate, operation, signal, label),
        createGate: (executor) => this.execution.createGate(executor) }),
        ...createWorkspaceContextTools(this.task.id, this.hosts, () => this.operationViews(), this.environment, () => this.assertRemoteActive()),
        ...this.journal.tools().filter((tool) => tool.name !== 'submit_verification')], this.progress, () => this.operationViews()),
      clarification: { ask: (id, questions, signal) => {
        this.assertRemoteActive();
        return this.intents.askClarification(id, questions, signal);
      } },
      assertActive: () => this.assertRemoteActive(),
      requestGeneration: () => this.requestGeneration(),
      beforeRequest: async (purpose, profile, attempt, signal) => {
        this.assertRemoteActive();
        if (this.progress.stalled) {
          this.setStatus('paused', '连续无进展，请检查后继续。');
          throw new Error('Conversation progress limit reached');
        }
        let roundId: string;
        try { const budget = await this.budget.reserve(attempt, signal); this.requestCount = budget.totalUsed; roundId = budget.roundId; }
        catch (error) {
          const pause = error instanceof RequestBudgetError ? budgetPauseNotice(error) : undefined;
          if (pause && this.status === 'running') this.setStatus('paused', pause.message, pause.reason);
          throw error;
        }
        this.assertRemoteActive(); signal?.throwIfAborted();
        // Pi's session profile may still carry an older extra reviewer object.
        // Reviewer policy is worker-owned and updated independently of model selection.
        this.profile = { ...this.profile, ...profile, reviewer: this.profile.reviewer };
        this.requestStarted = Date.now();
        this.signals.event({ type: 'model-request', taskId: this.task.id,
          model: { provider: profile.provider, modelId: profile.modelId }, purpose, roundId, logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt, transport: attempt.transport, request: this.requestCount, createdAt: Date.now() });
        this.signals.event({ type: 'task-status', taskId: this.task.id, status: this.status, requestCount: this.requestCount });
      },
      event: taskSessionEvents(this.task.id, { event: (event) => this.signals.event(event), usageBudget: () => this.agent ? this.preparationSnapshot().budget : undefined,
        request: () => ({ count: this.requestCount, started: this.requestStarted }), activity: () => this.publishExecution(),
        compactionFailed: (error) => { if (this.status === 'running') this.setStatus('paused', error); },
        diagnostic: (event) => this.diagnostic(event), turnEnd: () => this.progress.endTurn() })
    });
  }

  /** In-memory session/frame only; no prompt, tools, ordinary budget or task status transition. */
  async previewContext() {
    await this.initializeSession();
    return this.preparationSnapshot();
  }
  async start(restored = false, thinkingLevel?: import('@cloudhelm/core').ThinkingLevel, document?: import('@cloudhelm/core').MessageDocument, initialMessage?: string, intent?: string): Promise<void> {
    const version = this.controlVersion;
    if (!restored) this.setStatus('running');
    await this.initializeSession(thinkingLevel);
    if (!this.agent) throw new Error('对话初始化未完成');
    const interrupted = version !== this.controlVersion;
    if (restored || interrupted) { this.recovery.markNeedsRecovery(); this.setStatus('paused', undefined, this.resumeReason); return; }
    this.setStatus('running');
    try {
      this.intents.beginIntent(deriveInputIntent(initialMessage ?? this.task.goal, document, intent), document?.requestId);
      await this.agent.prompt(initialMessage ?? this.task.goal, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  answerClarification(id: string, answers: unknown): void { this.intents.answerClarification(id, answers); }
  cancelClarification(id: string): void { this.intents.cancelClarification(id); }

  preparationSnapshot(scopes: LocalScope[] = [], pendingIntent?: import('@cloudhelm/contracts').TaskIntentState): PreparationSnapshot {
    return taskContextSnapshot({ agent: this.agent, task: this.task, hosts: this.hosts, scopes, environment: this.environment,
      operations: this.operationViews(), round: this.verificationOperations(), intent: this.intents.snapshot(), pendingIntent, privileged: this.privileged,
      hasReport: this.journal.hasReport(),       needsRecovery: this.recovery.isRecoveryNeeded() || ['paused', 'failed', 'recovering', 'human-control'].includes(this.status),
      interruption: this.recovery.pendingInterruption, modelIdle: !this.agent?.isStreaming && !this.isRunning() && !this.stopping,
      remoteIdle: !this.terminal.pendingOperations(this.task.id).length && !this.operationViews().some((op) =>
        ['proposed', 'approved', 'running', 'unknown'].includes(op.status) && !op.reconciledAt) });
  }
  preparationContext(requestId: string, profile: RuntimeProfile, signal: AbortSignal, scopes: LocalScope[] = []) {
    return taskPreparation({ agent: this.agent, expectedProfile: profile, signal, profile: () => this.profile,
      generation: () => this.requestGeneration(), snapshot: () => this.preparationSnapshot(scopes),
      reserve: (attempt, requestSignal) => this.budget.reserve(attempt, requestSignal, requestId), charged: (model, budget, attempt) => {
        this.requestCount = budget.totalUsed; this.requestStarted = Date.now();
        this.signals.event({ type: 'model-request', taskId: this.task.id, purpose: 'compaction', request: this.requestCount,
          model: { provider: model.provider, modelId: model.modelId }, roundId: budget.roundId, logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt, transport: attempt.transport, createdAt: this.requestStarted });
      } });
  }

  cancelQueuedInput(id: string) { return this.intents.cancelQueuedInput(id); }

  message(text: string, document?: import('@cloudhelm/core').MessageDocument, intent?: string, preparedRevision?: string, queueMode: ConversationInputKind = 'steer'): void | Promise<void> {
    return this.intents.message(text, document, intent, preparedRevision, queueMode);
  }

  private async continueWithMessage(agent: ConversationSession, text: string, document?: import('@cloudhelm/core').MessageDocument): Promise<void> {
    try {
      await this.recovery.recoveryPreamble(agent);
      await agent.prompt(text, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  pause(): void {
    this.controlVersion++; this.reviews.invalidate('canceled');
    void this.intents.stopInputQueue().catch(() => this.blockRemote('队列停止状态保存失败；请核验后重新发送。'));
    if (!['running', 'waiting-review', 'waiting-user', 'human-control'].includes(this.status)) { void this.agent?.abort(); return; }
    this.setStatus('paused', undefined, 'interrupted');
    this.intents.cancelClarification();
    this.agent?.abort();
  }

  resume(): Promise<void> {
    return this.recovery.resume();
  }

  ownsTerminal(terminalId: string): boolean { return this.terminalPool.owns(terminalId) || !!this.privileged?.owns(terminalId); }

  /** Finished conversations may leave the worker; live ones must stay. */
  get canDelete(): boolean { return !this.intents.hasPendingInput && !isActiveTaskStatus(this.status) && !this.agent?.isStreaming && !this.terminal.pendingOperations(this.task.id).length; }

  async close(): Promise<void> {
    this.reviews.close();
    await this.agent?.abort();
    await this.agent?.waitForIdle();
    this.dispose();
  }

  /** Releases the task's terminals after the conversation has been deleted. */
  dispose(): void {
    this.reviews.close();
    this.intents.disposeInputQueue();
    this.background.close();
    this.agent?.dispose();
    this.signals.clearCredentials?.();
    this.privileged?.close();
    this.terminalPool.dispose();
  }

  addAuthorization(hosts: RuntimeHost[], scopes: LocalScope[], prepared?: import('@cloudhelm/contracts/runtime').PreparedContext & { text: string }): void {
    this.intents.addAuthorization(hosts, scopes, prepared);
  }

  private async ensureTerminal(hostId: string): Promise<string> {
    this.assertRemoteActive();
    const previous = this.terminalPool.latest(hostId), version = this.controlVersion;
    const opened = await this.terminalPool.acquire(hostId, () => {
      this.assertRemoteActive();
      if (version !== this.controlVersion) throw new Error('对话控制状态已变化，终端未投入使用');
    });
    this.assertRemoteActive();
    if (version !== this.controlVersion) throw new Error('对话控制状态已变化，终端未投入使用');
    // An occupied A and a new B coexist. Only a retired/human terminal is a replacement.
    if (previous && previous !== opened && !this.terminal.isAgentOwner(previous))
      this.signals.event({ type: 'terminal-replaced', previousTerminalId: previous, terminalId: opened });
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (host) await this.logicalContexts.syncFromProbe(hostId, host.username, this.terminal.workingDirectory(opened), {
      verify: this.verifyDefaultCwd ? (path) => this.verifyDefaultCwd!(hostId, path) : undefined,
      invalidate: () => this.reviews.invalidate() });
    return opened;
  }

  updateHostSafety(hostId: string, mode: ReviewMode, protectedReadPaths: string[], protectedWritePaths: string[], revision: number,
    preauthorization?: PreauthorizationScope | null): void {
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    this.reviews.invalidate();
    this.signals.clearCredentials?.();
    host.defaultMode = mode;
    host.protectedReadPaths = [...protectedReadPaths];
    host.protectedWritePaths = [...protectedWritePaths];
    host.protectedPaths = [...new Set([...protectedReadPaths, ...protectedWritePaths])];
    host.policyRevision = revision;
    if (preauthorization === null) delete host.preauthorization;
    else if (preauthorization !== undefined) host.preauthorization = preauthorization;
  }

  updateConversationReviewMode(hostId: string, mode: ReviewMode, revision: number): void {
    if (!this.task.hostIds.includes(hostId)) throw new Error('Host is outside this conversation');
    this.reviews.invalidate();
    this.task.reviewModesByHost = { ...this.task.reviewModesByHost, [hostId]: mode };
    this.task.reviewRevision = revision;
  }

  private scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope {
    const context = this.logicalContexts.get(host.id);
    // An unconfirmed default never silently falls back to a home directory or /.
    if (cwd === undefined && context?.defaultCwd === null)
      throw new Error('该主机的默认工作目录未确认（重建复核未通过或尚未重新设置），不会回退到家目录或 /。请先调用 set_default_cwd 设置已验证的默认目录，或为本操作显式指定 cwd。');
    return {
      taskId: this.task.id, hostId: host.id, cwd: cwd ?? context?.defaultCwd ?? this.terminal.workingDirectory(terminalId),
      runAs: host.username, loginAs: host.username, ...this.privileged?.scope(terminalId),
      terminalId, terminalGeneration: this.terminal.currentGeneration(terminalId), policyRevision: host.policyRevision,
      conversationRevision: this.task.reviewRevision ?? 1,
      reviewerRevision: this.profile.reviewer?.revision ?? 1,
      ...(context ? { contextRevision: context.revision } : {}),
      allowedWorkingRoots: ['/srv', '/opt', `/home/${host.username}`, '/root'],
      protectedPaths: [...host.protectedPaths], protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
      protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal: this.intents.goal(), intent: this.intents.snapshot()
    };
  }

  private diagnostic(event: DiagnosticEvent): void {
    this.signals.diagnostic?.(safeDiagnostic({ ...event, taskId: this.task.id }));
  }

  private assertRemoteActive(): void {
    if (this.remoteBlocked || !['running', 'waiting-review'].includes(this.status)) {
      throw new Error(this.remoteBlocked ?? 'Task is paused; wait for an explicit user continuation.');
    }
  }

  private clearRemoteBlock(): void {
    this.remoteBlocked = undefined;
    this.execution.resetDiagnosisOnly();
  }

  private blockRemote(reason: string, human = false, resumeReason?: ResumeReason): void {
    if (this.remoteBlocked) return;
    this.remoteBlocked = reason;
    void this.intents.stopInputQueue().catch(() => {});
    this.setStatus(human || this.status === 'human-control' ? 'human-control' : 'paused', reason, resumeReason);
    this.agent?.abort();
  }

  recordRemoteResult(result: OperationResult): void {
    this.execution.recordRemoteResult(result);
  }

  /** Cross-conversation recovery resolves outcomes this task may have created earlier. */
  assertResolvableOutcome(operationId: string): void {
    this.execution.assertResolvableOutcome(operationId);
  }

  /** Applies a user risk acceptance without ever claiming an observed outcome. */
  recordRiskAcceptance(accepted: OperationView): void {
    this.execution.recordRiskAcceptance(accepted);
  }

  setReviewKey(jevKey?: string): void { this.profile = { ...this.profile, jevKey }; this.agent?.setReviewKey(jevKey); }

  needsReviewProfile(reviewer: NonNullable<RuntimeProfile['reviewer']>): boolean {
    return needsTaskReviewer(this.profile, reviewer);
  }

  setReviewProfile(reviewer: NonNullable<RuntimeProfile['reviewer']>): void {
    reviewer = resolveTaskReviewer(this.profile, reviewer);
    if (!this.needsReviewProfile(reviewer)) return;
    this.reviews.invalidate();
    this.profile = { ...this.profile, reviewer: { ...reviewer,
      revision: Math.max(reviewer.revision, (this.profile.reviewer?.revision ?? 0) + 1) } };
  }

  async requestAiDenialReview(operationId: string): Promise<void> {
    await this.execution.requestAiDenialReview(operationId);
  }

  setThinking(level: import('@cloudhelm/core').ThinkingLevel): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.agent.setThinking(level);
  }

  setModel(profile: RuntimeProfile): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.reviews.invalidate();
    void this.intents.stopInputQueue().catch(() => this.blockRemote('切换模型时队列取消未获确认。'));
    this.agent.select(profile);
    this.profile = { ...profile, reviewer: profile.reviewer ? {
      ...profile.reviewer, revision: Math.max(profile.reviewer.revision, (this.profile.reviewer?.revision ?? 0) + 1)
    } : undefined };
  }

  isRunning(): boolean { return ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(this.status); }

  terminalInput(terminalId: string, data: string): void {
    // Ctrl+C is precise job control first: it interrupts exactly the command this
    // terminal is running, never unrelated work in the same conversation or task.
    if (data === '\u0003' && this.terminal.hasPending(terminalId)) {
      this.terminal.stopCommand(terminalId); return;
    }
    if (data === '\u0003' && this.isRunning()) { this.stopOperation('ctrl-c'); return; }
    if (this.isRunning()) throw new Error('AI 正在运行，请先停止再输入');
    if (this.terminal.hasPending(terminalId)) throw new Error('终端暂不可输入，请先停止 AI 并等待命令退出');
    // Typing is the explicit human takeover, and only this call makes the channel
    // human-owned; nothing else in the backend hands the AI terminal to a shell.
    this.terminal.releaseIdle(terminalId);
    this.terminal.input(terminalId, data, true);
  }

  stopOperation(source: InterruptionSource = 'stop-button'): void {
    if (this.stopping) return;
    const pending = this.terminal.pendingOperations(this.task.id);
    const operationIds = [...new Set([...pending, ...this.execution.operationsSnapshot().filter((op) => ['running', 'proposed', 'approved'].includes(op.status)).map((op) => op.id)])];
    if (!this.isRunning() && !pending.length && !operationIds.some((id) => !this.execution.getOperation(id)?.interruption)) return;
    this.stopping = true;
    this.publishExecution();
    const interruption: UserInterruption = { source, requestedAt: Date.now(), operationIds };
    this.recovery.recordInterruption(interruption);
    const text = source === 'terminal-close'
      ? '用户主动关闭终端，已停止本轮 AI。远端命令是否退出仍需核验；不得把这次中断当作程序自行失败或自动重试。'
      : `用户通过${source === 'ctrl-c' ? ' Ctrl+C ' : '停止按钮'}主动终止本轮执行。已请求停止远端命令，但不代表进程已退出；下一轮先核验结果，不自动重试被用户终止的操作。`;
    this.signals.event({ type: 'task-message', taskId: this.task.id, role: 'system', text, interruption, createdAt: interruption.requestedAt });
    for (const id of operationIds) {
      const op = this.execution.getOperation(id);
      if (op) { op.interruption = interruption; this.signals.event({ type: 'operation', value: op }); }
    }
    this.remoteBlocked = text;
    void this.intents.stopInputQueue().catch(() => {});
    this.agent?.clearQueue();
    // Pausing the model invalidates queued writes; it does not prove remote termination.
    this.agent?.abort();
    try { if (source !== 'terminal-close') this.terminal.stopTaskCommands(this.task.id); }
    catch (error) { this.stopping = false; throw error; }
    finally { this.pause(); this.setStatus('paused', text, 'interrupted'); }
  }

  private operationViews(): OperationView[] {
    return this.execution.operationViews();
  }

  private verificationOperations(): OperationView[] {
    return this.verification.operations(this.operationViews());
  }

  private finishRun(): void {
    this.journal.finalize(this.verification.id);
    const completion = decideTaskCompletion({ operations: this.operationViews(),
      roundOperations: this.verificationOperations(), answered: this.agent?.lastTurnAnswered ?? false,
      hasReport: this.journal.hasReport(), reportIssue: this.journal.lastReportIssue(), ...this.journal.completionReport() });
    if (completion.verificationState !== undefined) this.signals.event({ type: 'verification-state',
      taskId: this.task.id, value: completion.verificationState ?? undefined });
    if (completion.status === 'answered') this.verification.close(this.task.id);
    this.setStatus(completion.status, completion.summary, completion.resumeReason);
  }

  private requestGeneration(): string { return JSON.stringify([this.controlVersion, this.task.reviewRevision, this.profile.reviewer?.revision, this.hosts.map((host) => [host.id, host.policyRevision, this.environment?.snapshot(host.id, host.username).connectionId])]); }
  private publishExecution(): void {
    const model = this.agent?.isStreaming || this.isRunning() ? 'running' : 'idle';
    const pending = this.terminal.pendingOperations(this.task.id).length > 0;
    const remote = pending ? 'running' : this.operationViews().some((op) => op.status === 'unknown' && !op.reconciledAt) ? 'unknown' : 'idle';
    if (model === 'idle' && !pending) this.stopping = false;
    this.signals.event({ type: 'execution', taskId: this.task.id, value: {
      model, remote, stopping: this.stopping, canStop: model === 'running' || pending
    } });
  }

  private setStatus(status: TaskStatus, summary?: string, resumeReason?: ResumeReason): void {
    this.status = status;
    if (!this.isRunning()) this.reviews.invalidate('canceled');
    if (['paused', 'failed', 'human-control', 'recovering', 'answered'].includes(status))
      void this.intents.stopInputQueue().catch(() => this.blockRemote('待投递消息的终止状态保存失败。'));
    this.resumeReason = resumeReason;
    if (status === 'paused' || status === 'failed') this.journal.finalize(this.verification.id);
    this.publishExecution();
    if (!this.isRunning()) { this.signals.clearCredentials?.(); if (!this.background.hasLive) this.privileged?.close(); }
    // Pausing must not silently open a usable human shell; the channel stays
    // Agent-owned and idle so it can be reused instead of being consumed.
    this.signals.event({ type: 'task-status', taskId: this.task.id, status, summary, resumeReason, requestCount: this.requestCount });
  }
}
