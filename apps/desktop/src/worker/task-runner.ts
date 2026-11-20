import { TaskInputQueue, inputAuthorizationKey } from './task-input-queue.js';
import type { ConversationInput, ConversationInputKind, ExecutionTerminalBinding, HostEnvironmentAccess } from '@cloudhelm/core';
import { commitOperationSnapshot } from './operation-commit-client.js';
import { PROMPT_VERSION } from './agent-prompt.js';
import { createAuditedRemoteReader } from './audited-remote-read.js';
import { createBackgroundJobTool } from './background-job-tool.js';
import { createBackgroundOperations, type BackgroundOperations } from './background-operations.js';
import { createWorkspaceContextTools } from './workspace-context.js';
import { applyOperationDecision, applyOperationObservation } from './operation-observation.js';
import { operationToolResult } from './operation-feedback.js';
import { decideTaskCompletion } from './task-completion.js';
import { VerificationRoundTracker } from './verification-round.js';
import { verificationSource } from './verification-source.js';
import { randomUUID } from 'node:crypto';
import { operationPreview } from './operation-preview.js';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { ConversationTerminalPool, ClarificationCoordinator, SafetyGate, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, createConversationSession } from '@cloudhelm/adapters';
import { createTaskRiskEvaluator, needsTaskReviewer, resolveTaskReviewer } from './task-review-client.js';
import { TaskReviewLifetime } from './task-review-lifetime.js';
import { taskSessionEvents } from './task-session-events.js';
import type { TaskSignals } from './task-signals.js';
export type { TaskSignals } from './task-signals.js';
import { TaskRequestBudget, budgetPauseNotice } from './task-request-budget.js';
import { taskPreparation, assertPreparedInput, type PreparationSnapshot } from './task-preparation.js';
import { authorizeTaskInput } from './task-input-authorization.js';
import { interruptionContext } from './task-input-context.js';
import { taskContextSnapshot } from './task-context.js';
import { TaskProgress } from './task-progress.js';
import { observeProgressTools } from './task-progress-observer.js';
import { RequestBudgetError, PrivilegeError, privilegeGuidance, operationIntentKey, safeDiagnostic, serialCall, type ConversationSession, type SessionStorage, type DiagnosticEvent, redactOutput, type OperationAudit, type OperationResult, type OperationExecutor, type OperationScope, type ProposedOperation, type SafetyDecision, type ScriptInspector } from '@cloudhelm/core';
import type { LocalScope, OperationView, InterruptionSource, UserInterruption, ReviewMode, ResumeReason, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { isActiveTaskStatus, operationNeedsVerification, operationOutcomeResolvable } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { recoveryContextMessage } from './recovery-context.js';
import { mergeOperationViews } from './runtime-facts.js';
import { applyCommittedRiskAcceptance } from './risk-acceptance.js';
import { deriveInputIntent, TaskIntent } from './task-intent.js';
import { createRemoteTools } from './remote-tools.js';
import { createTaskPrompt } from './task-prompt.js';
import { createTaskApprovals } from './task-approval.js';
import { runOperationPipeline } from './operation-retry.js';
import { reviewCoordination } from './review-coordination.js';
import { reviewDeniedOperation } from './task-denial-review.js';
import { WorkJournal } from './work-journal.js';
import { LocalFileAccess } from './local-file-access.js';

export class TaskRunner {
  private readonly clarification: ClarificationCoordinator;
  private profile: RuntimeProfile;
  private readonly journal: WorkJournal;
  private readonly verification: VerificationRoundTracker;
  private controlVersion = 0;
  private resuming?: { version: number; promise: Promise<void> };
  private readonly intent: TaskIntent;
  private readonly localFiles: LocalFileAccess;
  private readonly analyzer = new BashAnalyzer();
  private readonly reviews = new TaskReviewLifetime();
  private agent?: ConversationSession;
  private readonly budget: TaskRequestBudget;
  private requestCount = 0;
  private requestStarted = 0;
  private readonly progress = new TaskProgress();
  private needsRecovery = false;
  private pendingInterruption?: UserInterruption;
  private lastFailureKey = '';
  private sameFailureCount = 0;
  private consecutiveAiDenials = 0;
  private readonly aiDeniedOperations = new Map<string, ProposedOperation>();
  private readonly manualReviewsInFlight = new Set<string>();
  private remoteBlocked?: string;
  private readonly operations = new Map<string, OperationView>();
  private readonly proposedOperations = new Map<string, ProposedOperation>();
  private readonly terminalPool: ConversationTerminalPool;
  private readonly background: BackgroundOperations;
  private readonly inputQueue: TaskInputQueue;
  private readonly replayProtected = new Set<string>();
  private stopping = false;
  private status: TaskStatus = 'draft';
  private resumeReason?: ResumeReason;
  /** One remote operation at a time: a queued call re-checks activity after the previous finishes. */
  private readonly runOperation = serialCall((gate: SafetyGate, operation: ProposedOperation,
    signal: AbortSignal | undefined, hostLabel: string, manualReview: boolean = false, onFileInspection?: import('@cloudhelm/core').ExecutionOptions['onFileInspection']) =>
    this.background.run(operation, signal, () => this.performOperation(gate, operation, signal, hostLabel, manualReview, onFileInspection)));

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
    private readonly readRemoteFile?: (hostId: string, path: string, cwd: string | undefined, signal?: AbortSignal, maxBytes?: number) => Promise<import('./remote-tool-dependencies.js').RemoteFileSnapshot>
  ) {
    const unobservedConnection = randomUUID();
    this.terminalPool = new ConversationTerminalPool(task.id, terminal, openTerminal, (hostId) => {
      const host = this.hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error('Host is outside this conversation');
      return { hostId, loginAs: host.username,
        connectionId: this.environment?.snapshot(hostId, host.username).connectionId ?? unobservedConnection };
    });
    this.background = createBackgroundOperations(task.id, priorOperations, this.operations,
      (operation) => signals.event({ type: 'operation', value: operation }), () => { if (!this.isRunning()) this.privileged?.close(); });
    this.intent = new TaskIntent(task, (value) => signals.event({ type: 'task-intent', taskId: task.id, value }));
    // Legacy report bookkeeping is not an instruction to resume model/remote work.
    this.resumeReason = task.resumeReason === 'report' ? undefined : task.resumeReason;
    this.verification = new VerificationRoundTracker(task, this.operationViews(), signals.event);
    for (const operation of priorOperations) this.replayProtected.add(operation.id);
    this.clarification = new ClarificationCoordinator(task.id, (request) => {
      if (request.status === 'answered') { this.intent.clarify(request); this.progress.observe('clarification', request.id); }
      this.signals.event({ type: 'clarification', value: request });
      if (request.status === 'pending') this.setStatus('waiting-user');
      if (request.status === 'answered') this.setStatus('running');
    }, () => { this.setStatus('paused', '需求澄清已停止，AI 不会猜测回答或自动继续。'); this.agent?.abort(); });
    this.profile = profile;
    this.requestCount = task.requestCount;
    this.budget = new TaskRequestBudget(task.id, signals.budget);
    this.journal = new WorkJournal(task.id, () => this.operationViews(), signals.event, this.readLog,
      (operation) => this.executor.reconcile?.(operation.hostId, operation.id) ?? false, (operation) => {
      this.operations.set(operation.id, operation);
      this.progress.observe('resolution', JSON.stringify([operation.id, operation.reconciliation?.kind]));
      this.signals.event({ type: 'operation', value: operation });
      this.publishExecution();
    }, () => this.verificationOperations(), () => this.verification.id, task.report);
    this.localFiles = new LocalFileAccess(task.localScopes ?? []);
    this.inputQueue = new TaskInputQueue(task.id, priorInputs, {
      session: () => { if (!this.agent) throw new Error('Session unavailable'); return this.agent; },
      authorizationKey: () => inputAuthorizationKey(this.task, this.hosts, this.profile, this.environment),
      assertActive: () => this.assertRemoteActive(), publish: () => {},
      commit: async (value) => { if (!signals.commitInput) throw new Error('Input persistence unavailable'); await signals.commitInput(value); },
      failed: () => this.blockRemote('消息队列确认失败，已暂停；不会自动重投。'),
      activate: (value) => {
        const next = this.intent.previewInput(value.intent, value.kind === 'followUp', value.id), snapshot = this.preparationSnapshot([], next);
        assertPreparedInput(snapshot, snapshot.revision, value.text);
        this.controlVersion++; this.intent.input(value.intent, value.kind === 'followUp', value.id); this.progress.reset();
      }
    });
  }

  private async initializeSession(thinkingLevel?: import('@cloudhelm/core').ThinkingLevel): Promise<void> {
    const gate = this.createGate();
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
        try { return await this.privileged.request(host, command, cwd, reason, this.intent.goal(), gate, signal, this.intent.snapshot(), method); }
        catch (error) { this.blockRemote(error instanceof PrivilegeError ? privilegeGuidance(error.feedback) : '提权上下文未建立；直接su通常需要root密码而非sudo密码。请处理后点击继续AI或明确发送下一步指令。', false, 'interrupted'); throw error; }
      }, scope: (host, id, cwd) => this.scope(host, id, cwd),
      readRemoteFile: createAuditedRemoteReader(this.task.id, this.hosts, this.readRemoteFile,
        this.signals, () => this.assertRemoteActive(), this.operations),
      runOperation: (gate, operation, signal, label, onFileInspection) => this.runOperation(gate, operation, signal, label, false, onFileInspection) }, gate);
    const currentSystemPrompt = createTaskPrompt(this.task, this.hosts, () => this.operationViews(), () => this.verificationOperations(), this.privileged, () => this.journal.hasReport(), () => this.intent.snapshot(), () => this.journal.submissionClosed(), this.environment);
    this.agent = await createConversationSession({
      thinkingLevel, profile: this.profile, storage: this.storage,
      inputSelected: (input) => this.inputQueue.selected(input), inputDelivered: (id, entryId) => this.inputQueue.delivered(id, entryId),
      inputHistoryAllowed: (id) => this.inputQueue.allowsHistory(id),
      queryReferenceAllowed: (id) => this.operations.has(id) || this.hosts.some((host) => host.id === id)
        || this.terminalPool.owns(id) || [...this.operations.values()].some((op) => op.executionJob?.jobId === id),
      systemPrompt: currentSystemPrompt(), currentSystemPrompt,
      tools: observeProgressTools([...remoteTools, createBackgroundJobTool({ background: this.background, terminal: this.terminal,
        executor: this.executor, hosts: this.hosts, operations: () => this.operationViews(), assertActive: () => this.assertRemoteActive(),
        scope: (host, id, cwd) => this.scope(host, id, cwd), runOperation: (gate, operation, signal, label) => this.runOperation(gate, operation, signal, label),
        createGate: (executor) => this.createGate(executor) }),
        ...createWorkspaceContextTools(this.task.id, this.hosts, () => this.operationViews(), this.environment, () => this.assertRemoteActive()),
        ...this.journal.tools().filter((tool) => tool.name !== 'submit_verification')], this.progress, () => this.operationViews()),
      clarification: { ask: (id, questions, signal) => {
        this.assertRemoteActive();
        return this.clarification.ask(id, questions, signal);
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
    if (restored || interrupted) { this.needsRecovery = true; this.setStatus('paused', undefined, this.resumeReason); return; }
    this.setStatus('running');
    try {
      this.intent.begin(deriveInputIntent(initialMessage ?? this.task.goal, document, intent), document?.requestId);
      await this.agent.prompt(initialMessage ?? this.task.goal, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  answerClarification(id: string, answers: unknown): void { this.clarification.answer(id, answers); }
  cancelClarification(id: string): void { this.clarification.cancel(id); }

  preparationSnapshot(scopes: LocalScope[] = [], pendingIntent?: import('@cloudhelm/contracts').TaskIntentState): PreparationSnapshot {
    return taskContextSnapshot({ agent: this.agent, task: this.task, hosts: this.hosts, scopes, environment: this.environment,
      operations: this.operationViews(), round: this.verificationOperations(), intent: this.intent.snapshot(), pendingIntent, privileged: this.privileged,
      hasReport: this.journal.hasReport(), needsRecovery: this.needsRecovery || ['paused', 'failed', 'recovering', 'human-control'].includes(this.status),
      interruption: this.pendingInterruption, modelIdle: !this.agent?.isStreaming && !this.isRunning() && !this.stopping,
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

  cancelQueuedInput(id: string) { return this.inputQueue.cancel(id); }

  message(text: string, document?: import('@cloudhelm/core').MessageDocument, intent?: string, preparedRevision?: string, queueMode: ConversationInputKind = 'steer'): void | Promise<void> {
    if (!['steer', 'followUp'].includes(queueMode)) throw new Error('Invalid message queue mode');
    if (this.status === 'waiting-user') throw new Error('请先回答需求澄清，或停止本轮对话');
    if (!this.agent) throw new Error('Task has not started');
    if (this.agent.isStreaming && !['running', 'waiting-review'].includes(this.status)) throw new Error('AI 正在暂停，请稍后再发送消息。');
    // Only a closed, backend-recorded round can be replaced. Ordinary chat is never risk acceptance.
    const newRound = !this.remoteBlocked && !this.agent.isStreaming && this.verification.closed
      && this.resumeReason !== 'report' && !this.operationViews().some(operationNeedsVerification);
    const nextIntent = this.intent.previewInput(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    const snapshot = this.preparationSnapshot([], preparedRevision ? undefined : nextIntent);
    assertPreparedInput(snapshot, preparedRevision ?? snapshot.revision, text);
    if (this.agent.isStreaming) return this.inputQueue.enqueue({ id: document?.requestId ?? randomUUID(), kind: queueMode,
      text, document, intent: deriveInputIntent(text, document, intent) }).then(() => {});
    this.controlVersion++;
    // Replay protection is released by backend facts, never by report wording alone:
    // nothing may be unresolved, and any change this round recorded must be verified.
    // A round that recorded no change releases immediately, so report bookkeeping
    // cannot keep an identical intent blocked forever; a repeat of an unverified
    // change stays blocked under any new ID, because that is a retry, not a new
    // operation. Genuinely different operations are never blocked by this set.
    const recordedChange = this.verification.operations(this.operationViews())
      .some((operation) => operation.status === 'succeeded' && operation.readOnly !== true);
    const settled = !this.remoteBlocked
      && !this.operationViews().some((operation) => operationNeedsVerification(operation))
      && (!recordedChange || this.journal.completionReport().reportStatus === 'verified');
    if (settled) this.replayProtected.clear();
    if (['paused', 'failed', 'recovering', 'human-control'].includes(this.status)) this.needsRecovery = true;
    this.remoteBlocked = undefined;
    this.intent.input(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    if (newRound) {
      this.journal.resetReport();
      this.signals.event({ type: 'verification-state', taskId: this.task.id });
    }
    this.progress.reset();
    if (newRound) this.verification.begin(this.task.id);
    this.setStatus('running');
    void this.continueWithMessage(this.agent, text, document);
  }

  private async continueWithMessage(agent: ConversationSession, text: string, document?: import('@cloudhelm/core').MessageDocument): Promise<void> {
    try {
      if (this.needsRecovery) {
        await agent.context(recoveryContextMessage(this.operationViews()));
        this.needsRecovery = false;
      }
      await this.appendInterruptionContext(agent);
      await agent.prompt(text, document);
      if (this.status === 'running') this.finishRun();
    } catch (error) {
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
    }
  }

  pause(): void {
    this.controlVersion++; this.reviews.invalidate('canceled');
    void this.inputQueue.stop().catch(() => this.blockRemote('队列停止状态保存失败；请核验后重新发送。'));
    if (!['running', 'waiting-review', 'waiting-user', 'human-control'].includes(this.status)) { void this.agent?.abort(); return; }
    this.setStatus('paused', undefined, 'interrupted');
    this.clarification.cancel();
    this.agent?.abort();
  }

  resume(): Promise<void> {
    if (this.status === 'waiting-user') return Promise.reject(new Error('请先回答问题或停止本轮对话'));
    if (this.resuming?.version === this.controlVersion) return this.resuming.promise;
    if (!['paused', 'failed', 'human-control', 'recovering'].includes(this.status)
      || !this.resumeReason || this.resumeReason === 'report') {
      return Promise.reject(new Error('没有可自动继续的未完成步骤，请明确发送下一步指令。'));
    }
    const reason = this.resumeReason;
    const version = ++this.controlVersion;
    const promise = this.resumeOnce(version, reason).catch((error: unknown) => {
      if (version !== this.controlVersion) return;
      if (error instanceof RequestBudgetError) throw error;
      if (this.status === 'paused' || this.status === 'human-control') return;
      // User stop or a SafetyGate block already published the authoritative pause; ignore Pi's late abort error.
      if (this.status === 'running') this.setStatus('failed', error instanceof Error ? error.message : String(error), 'model');
      throw error;
    }).finally(() => {
      if (this.resuming?.version === version) this.resuming = undefined;
    });
    this.resuming = { version, promise };
    return promise;
  }

  private async resumeOnce(version: number, reason: ResumeReason): Promise<void> {
    if (!this.agent) return;
    await this.agent.waitForIdle();
    if (version !== this.controlVersion) return;
    await this.budget.assertAvailable();
    if (version !== this.controlVersion) return;
    this.setStatus('running');
    for (const { id: hostId } of this.hosts) {
      const previous = this.terminalPool.latest(hostId);
      if (!previous || this.terminal.isAgentOwner(previous)) continue;
      const opened = await this.terminalPool.acquire(hostId, () => {
        if (version !== this.controlVersion) throw new Error('对话控制状态已变化，终端未投入使用');
      });
      this.signals.event({ type: 'terminal-replaced', previousTerminalId: previous, terminalId: opened });
      if (!this.terminal.isAgentOwner(opened)) {
        this.blockRemote('终端状态已变化，请核验后继续。');
        return;
      }
    }
    this.progress.reset();
    this.remoteBlocked = undefined;
    this.setStatus('running');
    await this.appendInterruptionContext(this.agent);
    this.needsRecovery = false;
    const operations = this.operationViews();
    await this.agent.resumeWithContext(recoveryContextMessage(operations, reason));
    if (this.status === 'running') this.finishRun();
  }

  ownsTerminal(terminalId: string): boolean { return this.terminalPool.owns(terminalId) || !!this.privileged?.owns(terminalId); }

  /** Finished conversations may leave the worker; live ones must stay. */
  get canDelete(): boolean { return !this.inputQueue.hasPending && !isActiveTaskStatus(this.status) && !this.agent?.isStreaming && !this.terminal.pendingOperations(this.task.id).length; }

  async close(): Promise<void> {
    this.reviews.close();
    await this.agent?.abort();
    await this.agent?.waitForIdle();
    this.dispose();
  }

  /** Releases the task's terminals after the conversation has been deleted. */
  dispose(): void {
    this.reviews.close();
    this.inputQueue.dispose();
    this.background.close();
    this.agent?.dispose();
    this.signals.clearCredentials?.();
    this.privileged?.close();
    this.terminalPool.dispose();
  }

  addAuthorization(hosts: RuntimeHost[], scopes: LocalScope[], prepared?: import('@cloudhelm/contracts/runtime').PreparedContext & { text: string }): void {
    authorizeTaskInput(this.task, this.hosts, hosts, scopes, (next) => this.preparationSnapshot(next), (event) => this.signals.event(event), prepared);
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
    return opened;
  }

  updateHostSafety(hostId: string, mode: ReviewMode, protectedReadPaths: string[], protectedWritePaths: string[], revision: number): void {
    const host = this.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    this.reviews.invalidate();
    this.signals.clearCredentials?.();
    host.defaultMode = mode;
    host.protectedReadPaths = [...protectedReadPaths];
    host.protectedWritePaths = [...protectedWritePaths];
    host.protectedPaths = [...new Set([...protectedReadPaths, ...protectedWritePaths])];
    host.policyRevision = revision;
  }

  updateConversationReviewMode(hostId: string, mode: ReviewMode, revision: number): void {
    if (!this.task.hostIds.includes(hostId)) throw new Error('Host is outside this conversation');
    this.reviews.invalidate();
    this.task.reviewModesByHost = { ...this.task.reviewModesByHost, [hostId]: mode };
    this.task.reviewRevision = revision;
  }

  private scope(host: RuntimeHost, terminalId: string, cwd = this.terminal.workingDirectory(terminalId)): OperationScope {
    return {
      taskId: this.task.id, hostId: host.id, cwd, runAs: host.username, loginAs: host.username, ...this.privileged?.scope(terminalId),
      terminalId, terminalGeneration: this.terminal.currentGeneration(terminalId), policyRevision: host.policyRevision,
      conversationRevision: this.task.reviewRevision ?? 1,
      reviewerRevision: this.profile.reviewer?.revision ?? 1,
      allowedWorkingRoots: ['/srv', '/opt', `/home/${host.username}`, '/root'],
      protectedPaths: [...host.protectedPaths], protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
      protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal: this.intent.goal(), intent: this.intent.snapshot()
    };
  }

  /** Same fact the host write lock uses, checked before an approval card or AI review. */
  private pendingOutcomeBlocker(hostId: string): string | undefined {
    const unresolved = this.operationViews().find((operation) => operation.hostId === hostId && operationNeedsVerification(operation));
    return unresolved
      ? `A previous operation on this host (${unresolved.id}, ${unresolved.status}) still has an unresolved remote outcome; writes are locked until it is verified.`
      : undefined;
  }

  private async performOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined,
    hostLabel: string, manualReview = false, onFileInspection?: import('@cloudhelm/core').ExecutionOptions['onFileInspection']) {
    this.assertRemoteActive();
    const final = await runOperationPipeline({ gate, signal, manualReview,
      preflight: { privileged: this.privileged, analyzer: this.analyzer, environment: this.environment,
        operations: () => this.operationViews(), replayProtected: this.replayProtected, hostBlocked: (hostId) => this.pendingOutcomeBlocker(hostId) },
      gateObserver: (candidate) => candidate.kind === 'command' && candidate.executionMode === 'background'
        ? { onProcessStarted: (event) => this.background.started(candidate.id, event) } : { onFileInspection },
      coordinateDecision: (decision) => this.coordinateDecision(decision),
      onRetry: (previousOperationId, nextAttempt) => this.diagnostic({ event: 'operation.retry', operationId: previousOperationId,
        attempt: nextAttempt, failureKind: 'not-dispatched', hostId: operation.scope.hostId })
    }, operation);
    if ('feedback' in final) return final.feedback;
    operation = final.operation;
    const outcome = final.outcome;
    const result = outcome.result!;
    if (this.background.detached(operation.id) || operation.kind === 'command' && operation.processControl) return operationToolResult(result, hostLabel, outcome.readOnly, operation.scope);
    if (result.requiresUserAction) {
      this.blockRemote(result.privilege ? privilegeGuidance(result.privilege) : '认证未通过或当前认证形式需要人工接管，已暂停。请处理后手动继续，AI 不会自动改换方式重试。', false, 'interrupted');
    } else if (result.status === 'handed-over') {
      this.blockRemote('终端已转为人工输入；请核验结果后发送消息继续。');
    } else if (result.status === 'unknown') {
      this.blockRemote('远端操作结果未知，已暂停。请先核验，避免重复执行。', false, 'verify');
    } else if (!this.terminal.isAgentOwner(operation.scope.terminalId)) {
      this.blockRemote('远端终端已暂停或被接管，请核验后手动继续。');
    } else if (result.status === 'failed' && result.effects === 'possible' && outcome.readOnly !== true) {
      this.blockRemote('操作失败且可能已产生部分变更。已暂停，请先核验原结果，再决定后续操作。', false, 'verify');
    } else if (result.status === 'failed') {
      const key = `${operation.scope.hostId}:${this.preview(operation)}:${result.exitCode ?? 'unknown'}`;
      this.sameFailureCount = key === this.lastFailureKey ? this.sameFailureCount + 1 : 1;
      this.lastFailureKey = key;
      if (this.sameFailureCount >= 3) {
        this.setStatus('paused', 'The same operation failed three consecutive times');
        this.agent?.abort();
      }
    } else if (result.status === 'succeeded') {
      this.progress.observe('operation', JSON.stringify([operationIntentKey(operation), result.stdoutTail, result.exitCode, result.effects]));
      this.sameFailureCount = 0;
      this.lastFailureKey = '';
    }
    return operationToolResult(result, hostLabel, outcome.readOnly, operation.scope);
  }

  private diagnostic(event: DiagnosticEvent): void {
    this.signals.diagnostic?.(safeDiagnostic({ ...event, taskId: this.task.id }));
  }

  private preview(operation: ProposedOperation): string { return operationPreview(operation); }

  private assertRemoteActive(): void {
    if (this.remoteBlocked || !['running', 'waiting-review'].includes(this.status)) {
      throw new Error(this.remoteBlocked ?? 'Task is paused; wait for an explicit user continuation.');
    }
  }

  private blockRemote(reason: string, human = false, resumeReason?: ResumeReason): void {
    if (this.remoteBlocked) return;
    this.remoteBlocked = reason;
    void this.inputQueue.stop().catch(() => {});
    this.setStatus(human || this.status === 'human-control' ? 'human-control' : 'paused', reason, resumeReason);
    this.agent?.abort();
  }

  /** Round-level coordination for one review outcome; never a side effect of the audit record. */
  private coordinateDecision(decision: SafetyDecision): void {
    if (decision.ruleId === 'ai-review-deny' && this.consecutiveAiDenials >= 3) {
      this.blockRemote('独立审核连续拒绝三次，已暂停以避免反复试探。请检查目标或人工处理。');
      return;
    }
    if (reviewCoordination(decision) === 'pause-round') {
      this.blockRemote(`操作未执行，审核未放行（${decision.ruleId}）：${decision.reason}。已暂停，请处理后手动继续。`);
    }
  }

  private createGate(executor: OperationExecutor = this.executor): SafetyGate {
    const audit: OperationAudit = {
      proposed: async (operation) => {
        this.diagnostic({ event: 'operation.proposed', hostId: operation.scope.hostId, operationId: operation.id,
          runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, sessionId: operation.scope.sessionId, cwd: operation.scope.cwd, policyRevision: operation.scope.policyRevision });
        this.proposedOperations.set(operation.id, operation);
        this.updateOperation(operation, 'proposed', await verificationSource(operation, this.analyzer));
        if (operation.kind === 'command' && operation.executionMode === 'background') {
          const connectionId = operation.scope.sessionId ? `privileged:${operation.scope.sessionId}`
            : this.terminalPool.snapshot().find((entry) => entry.terminalId === operation.scope.terminalId)?.connectionId;
          if (!connectionId) throw new Error('Background connection binding unavailable');
          this.background.proposed(operation, connectionId);
        }
        await commitOperationSnapshot(this.operations.get(operation.id), this.signals.commitOperation);
      },
      classified: async (id, readOnly, impact) => {
        const view = this.operations.get(id);
        if (!view) return;
        view.readOnly = readOnly; view.impactAnalysis = impact;
        this.signals.event({ type: 'operation', value: view });
      },
      decided: async (id, decision) => {
        this.diagnostic({ event: 'review.result', operationId: id, status: decision.verdict, ruleId: decision.ruleId });
        const view = this.operations.get(id);
        if (view) {
          applyOperationDecision(view, decision, this.consecutiveAiDenials);
          this.signals.event({ type: 'operation', value: view });
        }
        await commitOperationSnapshot(this.operations.get(id), this.signals.commitOperation);
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
        this.signals.event({ type: 'operation', value: operation });
        await commitOperationSnapshot(operation, this.signals.commitOperation);
        this.verification.pending(this.task.id, operation, this.operationViews());
        if (!this.isRunning()) this.journal.finalize(this.verification.id);
        this.publishExecution();
      }
    };
    return new SafetyGate({
      analyzer: this.analyzer,
      scripts: this.scripts,
      reviewSignal: () => this.reviews.signal(),
      evaluator: createTaskRiskEvaluator(this.task.id, this.signals.budget, () => this.assertRemoteActive(),
        () => this.requestGeneration(), () => this.profile,
      () => this.operationViews().slice(-5).map((item) => `${item.kind} ${item.status}: ${item.kind === 'command' ? redactOutput(item.preview).slice(0, 400) : item.preview.split('\n')[0]}`), (event) => this.diagnostic(event)),
      approvals: createTaskApprovals(this.signals, (operation) => this.preview(operation),
        () => this.setStatus('waiting-review'), () => { if (this.status === 'waiting-review') this.setStatus('running'); }),
      executor, audit, lease: {
        currentGeneration: (id) => this.terminal.currentGeneration(id),
        isAgentOwner: (id) => this.terminal.isAgentOwner(id)
      },
      isOperationActive: (operation) => (!this.remoteBlocked && ['running', 'waiting-review'].includes(this.status))
        || this.background.hasOperationLease(operation),
      settings: (hostId) => ({ mode: this.task.reviewModesByHost?.[hostId]
        ?? this.hosts.find((host) => host.id === hostId)?.defaultMode ?? 'ask',
        revision: this.hosts.find((host) => host.id === hostId)?.policyRevision ?? -1,
        conversationRevision: this.task.reviewRevision ?? 1,
        reviewerRevision: this.profile.reviewer?.revision ?? 1 })
    });
  }

  private updateOperation(operation: ProposedOperation, status: OperationView['status'], source?: OperationView['verificationSource']): void {
    this.verification.record(this.task.id, operation.id);
    const connectionId = operation.scope.sessionId ? `privileged:${operation.scope.sessionId}`
      : this.environment?.snapshot(operation.scope.hostId, operation.scope.loginAs ?? operation.scope.runAs).connectionId;
    const view: OperationView = {
      ...(connectionId ? { executionContext: { version: 1, connectionId, terminalId: operation.scope.terminalId,
        terminalGeneration: operation.scope.terminalGeneration } } : {}),
      ...(operation.kind === 'command' && operation.processControl ? { processControl: { ...operation.processControl } } : {}),
      ...(operation.kind === 'command' && operation.probe ? { internal: 'identity-probe' as const } : {}), ...(operation.kind === 'command' && operation.executionChannel ? { executionChannel: operation.executionChannel } : {}),
      verificationSource: source,
      outputExpectation: operation.kind === 'command' ? operation.outputExpectation : undefined,
      serviceUnit: operation.kind === 'command' ? operation.serviceUnit : undefined,
      commandSource: operation.kind === 'command' && redactOutput(operation.scope.cwd) === operation.scope.cwd
        ? { version: 1, cwd: operation.scope.cwd } : undefined,
      intentKey: operationIntentKey(operation), id: operation.id, taskId: this.task.id, hostId: operation.scope.hostId, kind: operation.kind,
      promptVersion: PROMPT_VERSION,
      preview: this.preview(operation), status, runAs: operation.scope.runAs, loginAs: operation.scope.loginAs, logRef: operation.scope.terminalId,
      model: { provider: this.profile.provider, modelId: this.profile.modelId }, createdAt: Date.now()
    };
    this.replayProtected.add(operation.id);
    this.operations.set(operation.id, view);
    this.signals.event({ type: 'operation', value: view });
  }

  recordRemoteResult(result: OperationResult): void {
    this.background.observe(result);
    const operation = this.operations.get(result.operationId);
    if (!operation) return;
    applyOperationObservation(operation, result);
    this.signals.event({ type: 'operation', value: operation });
    this.verification.pending(this.task.id, operation, this.operationViews());
    this.publishExecution();
    if (this.status === 'answered') this.finishRun();
    else if (!this.isRunning()) this.journal.finalize(this.verification.id);
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
    if (accepted.taskId !== this.task.id) return;
    const operation = this.operationViews().find((item) => item.id === accepted.id);
    if (!operation) return;
    this.operations.set(operation.id, applyCommittedRiskAcceptance(operation, accepted));
    this.progress.observe('resolution', JSON.stringify([operation.id, accepted.reconciliation?.kind]));
    if (this.status === 'answered') this.finishRun();
    else this.journal.finalize(this.verification.id);
    this.publishExecution();
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
    await reviewDeniedOperation(operationId, { task: this.task, hosts: this.hosts, agent: this.agent, terminal: this.terminal,
      pool: this.terminalPool, operations: this.operations, denied: this.aiDeniedOperations, inFlight: this.manualReviewsInFlight,
      version: () => this.controlVersion, blocked: () => !!this.remoteBlocked, reviewerRevision: () => this.profile.reviewer?.revision ?? 1,
      scope: (host, id, cwd) => this.scope(host, id, cwd), event: this.signals.event,
      start: () => this.setStatus('running'), finish: () => { if (this.status === 'running') this.setStatus('paused', '人工复核已结束，请核验这次操作的实际结果'); },
      execute: (operation, label) => this.runOperation(this.createGate(), operation, undefined, label, true) });
  }

  setThinking(level: import('@cloudhelm/core').ThinkingLevel): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.agent.setThinking(level);
  }

  setModel(profile: RuntimeProfile): void {
    if (!this.agent) throw new Error('会话尚未就绪');
    this.reviews.invalidate();
    void this.inputQueue.stop().catch(() => this.blockRemote('切换模型时队列取消未获确认。'));
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
    const operationIds = [...new Set([...pending, ...[...this.operations.values()].filter((op) => ['running', 'proposed', 'approved'].includes(op.status)).map((op) => op.id)])];
    if (!this.isRunning() && !pending.length && !operationIds.some((id) => !this.operations.get(id)?.interruption)) return;
    this.stopping = true;
    this.publishExecution();
    const interruption: UserInterruption = { source, requestedAt: Date.now(), operationIds };
    this.pendingInterruption = interruption;
    const text = source === 'terminal-close'
      ? '用户主动关闭终端，已停止本轮 AI。远端命令是否退出仍需核验；不得把这次中断当作程序自行失败或自动重试。'
      : `用户通过${source === 'ctrl-c' ? ' Ctrl+C ' : '停止按钮'}主动终止本轮执行。已请求停止远端命令，但不代表进程已退出；下一轮先核验结果，不自动重试被用户终止的操作。`;
    this.signals.event({ type: 'task-message', taskId: this.task.id, role: 'system', text, interruption, createdAt: interruption.requestedAt });
    for (const id of operationIds) {
      const op = this.operations.get(id);
      if (op) { op.interruption = interruption; this.signals.event({ type: 'operation', value: op }); }
    }
    this.remoteBlocked = text;
    void this.inputQueue.stop().catch(() => {});
    this.agent?.clearQueue();
    // Pausing the model invalidates queued writes; it does not prove remote termination.
    this.agent?.abort();
    try { if (source !== 'terminal-close') this.terminal.stopTaskCommands(this.task.id); }
    catch (error) { this.stopping = false; throw error; }
    finally { this.pause(); this.setStatus('paused', text, 'interrupted'); }
  }

  private async appendInterruptionContext(agent: ConversationSession): Promise<void> {
    if (!this.pendingInterruption) return;
    const interruption = this.pendingInterruption;
    this.pendingInterruption = undefined;
    await agent.context(interruptionContext(interruption, this.operationViews()));
  }

  private operationViews(): OperationView[] {
    return mergeOperationViews([...this.priorOperations, ...this.operations.values()]);
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
      void this.inputQueue.stop().catch(() => this.blockRemote('待投递消息的终止状态保存失败。'));
    this.resumeReason = resumeReason;
    if (status === 'paused' || status === 'failed') this.journal.finalize(this.verification.id);
    this.publishExecution();
    if (!this.isRunning()) { this.signals.clearCredentials?.(); if (!this.background.hasLive) this.privileged?.close(); }
    // Pausing must not silently open a usable human shell; the channel stays
    // Agent-owned and idle so it can be reused instead of being consumed.
    this.signals.event({ type: 'task-status', taskId: this.task.id, status, summary, resumeReason, requestCount: this.requestCount });
  }
}
