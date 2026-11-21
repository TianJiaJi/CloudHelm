import { randomUUID } from 'node:crypto';
import { ClarificationCoordinator } from '@cloudhelm/application';
import type { ClarificationAnswer, ClarificationQuestion, ConversationInput, ConversationInputKind,
  ConversationSession, HostEnvironmentAccess, MessageDocument } from '@cloudhelm/core';
import type { AppEvent, LocalScope, OperationView, ResumeReason, TaskIntentState, TaskStatus, TaskView } from '@cloudhelm/contracts';
import { operationNeedsVerification } from '@cloudhelm/contracts';
import type { PreparedContext, RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { assertPreparedInput, type PreparationSnapshot } from './task-preparation.js';
import { authorizeTaskInput } from './task-input-authorization.js';
import { deriveInputIntent, TaskIntent } from './task-intent.js';
import { TaskInputQueue, inputAuthorizationKey } from './task-input-queue.js';
import type { TaskSignals } from './task-signals.js';

/** Runtime facts the intent layer reads but never owns. */
export interface IntentFacts {
  agent(): ConversationSession | undefined;
  profile(): RuntimeProfile;
  status(): TaskStatus;
  remoteBlocked(): string | undefined;
  resumeReason(): ResumeReason | undefined;
  operationViews(): OperationView[];
  verificationClosed(): boolean;
  roundOperations(): OperationView[];
  completionReportVerified(): boolean;
}

/** Cross-cutting state transitions owned by the task runtime. */
export interface IntentEffects {
  assertRemoteActive(): void;
  blockRemote(reason: string, human?: boolean, resumeReason?: ResumeReason): void;
  setStatus(status: TaskStatus, summary?: string, resumeReason?: ResumeReason): void;
  bumpControlVersion(): void;
  markNeedsRecovery(): void;
  releaseReplayProtection(): void;
  clearRemoteBlocked(): void;
  resetReport(): void;
  resetProgress(): void;
  observeProgress(kind: string, key: string): void;
  beginVerificationRound(taskId: string): void;
  preparationSnapshot(scopes?: LocalScope[], pendingIntent?: TaskIntentState): PreparationSnapshot;
  continueWithMessage(agent: ConversationSession, text: string, document?: MessageDocument): void;
  abortAgent(): void;
}

/** Owns user-intent state: message admission, queued input, clarification and authorization grants. */
export class IntentManager {
  private readonly intent: TaskIntent;
  private readonly inputQueue: TaskInputQueue;
  private readonly clarification: ClarificationCoordinator;

  constructor(private readonly task: TaskView, private readonly hosts: RuntimeHost[],
    private readonly environment: HostEnvironmentAccess | undefined, private readonly signals: TaskSignals,
    priorInputs: readonly ConversationInput[], private readonly facts: IntentFacts, private readonly effects: IntentEffects) {
    this.intent = new TaskIntent(task, (value) => signals.event({ type: 'task-intent', taskId: task.id, value }));
    this.clarification = new ClarificationCoordinator(task.id, (request) => {
      if (request.status === 'answered') { this.intent.clarify(request); this.effects.observeProgress('clarification', request.id); }
      this.signals.event({ type: 'clarification', value: request });
      if (request.status === 'pending') this.effects.setStatus('waiting-user');
      if (request.status === 'answered') this.effects.setStatus('running');
    }, () => { this.effects.setStatus('paused', '需求澄清已停止，AI 不会猜测回答或自动继续。'); this.effects.abortAgent(); });
    this.inputQueue = new TaskInputQueue(task.id, priorInputs, {
      session: () => { const agent = this.facts.agent(); if (!agent) throw new Error('Session unavailable'); return agent; },
      authorizationKey: () => inputAuthorizationKey(this.task, this.hosts, this.facts.profile(), this.environment),
      assertActive: () => this.effects.assertRemoteActive(), publish: () => {},
      commit: async (value) => { if (!this.signals.commitInput) throw new Error('Input persistence unavailable'); await this.signals.commitInput(value); },
      failed: () => this.effects.blockRemote('消息队列确认失败，已暂停；不会自动重投。'),
      activate: (value) => {
        const next = this.intent.previewInput(value.intent, value.kind === 'followUp', value.id), snapshot = this.effects.preparationSnapshot([], next);
        assertPreparedInput(snapshot, snapshot.revision, value.text);
        this.effects.bumpControlVersion(); this.intent.input(value.intent, value.kind === 'followUp', value.id); this.effects.resetProgress();
      }
    });
  }

  goal(): string { return this.intent.goal(); }

  snapshot(): TaskIntentState { return this.intent.snapshot(); }

  /** Only the real initial input can replace a short UI conversation title. */
  beginIntent(text: string, requestId?: string): void { this.intent.begin(text, requestId); }

  message(text: string, document?: MessageDocument, intent?: string, preparedRevision?: string, queueMode: ConversationInputKind = 'steer'): void | Promise<void> {
    if (!['steer', 'followUp'].includes(queueMode)) throw new Error('Invalid message queue mode');
    if (this.facts.status() === 'waiting-user') throw new Error('请先回答需求澄清，或停止本轮对话');
    const agent = this.facts.agent();
    if (!agent) throw new Error('Task has not started');
    if (agent.isStreaming && !['running', 'waiting-review'].includes(this.facts.status())) throw new Error('AI 正在暂停，请稍后再发送消息。');
    // Only a closed, backend-recorded round can be replaced. Ordinary chat is never risk acceptance.
    const newRound = !this.facts.remoteBlocked() && !agent.isStreaming && this.facts.verificationClosed()
      && this.facts.resumeReason() !== 'report' && !this.facts.operationViews().some(operationNeedsVerification);
    const nextIntent = this.intent.previewInput(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    const snapshot = this.effects.preparationSnapshot([], preparedRevision ? undefined : nextIntent);
    assertPreparedInput(snapshot, preparedRevision ?? snapshot.revision, text);
    if (agent.isStreaming) return this.inputQueue.enqueue({ id: document?.requestId ?? randomUUID(), kind: queueMode,
      text, document, intent: deriveInputIntent(text, document, intent) }).then(() => {});
    this.effects.bumpControlVersion();
    // Replay protection is released by backend facts, never by report wording alone:
    // nothing may be unresolved, and any change this round recorded must be verified.
    // A round that recorded no change releases immediately, so report bookkeeping
    // cannot keep an identical intent blocked forever; a repeat of an unverified
    // change stays blocked under any new ID, because that is a retry, not a new
    // operation. Genuinely different operations are never blocked by this set.
    const recordedChange = this.facts.roundOperations()
      .some((operation) => operation.status === 'succeeded' && operation.readOnly !== true);
    const settled = !this.facts.remoteBlocked()
      && !this.facts.operationViews().some((operation) => operationNeedsVerification(operation))
      && (!recordedChange || this.facts.completionReportVerified());
    if (settled) this.effects.releaseReplayProtection();
    if (['paused', 'failed', 'recovering', 'human-control'].includes(this.facts.status())) this.effects.markNeedsRecovery();
    this.effects.clearRemoteBlocked();
    this.intent.input(deriveInputIntent(text, document, intent), newRound, document?.requestId);
    if (newRound) this.effects.resetReport();
    this.effects.resetProgress();
    if (newRound) this.effects.beginVerificationRound(this.task.id);
    this.effects.setStatus('running');
    this.effects.continueWithMessage(agent, text, document);
  }

  cancelQueuedInput(id: string): Promise<{ value: ConversationInput; cancelled: boolean }> { return this.inputQueue.cancel(id); }

  answerClarification(id: string, answers: unknown): void { this.clarification.answer(id, answers); }

  cancelClarification(id?: string): void { this.clarification.cancel(id); }

  askClarification(toolCallId: string, questions: ClarificationQuestion[], signal?: AbortSignal): Promise<ClarificationAnswer[]> {
    return this.clarification.ask(toolCallId, questions, signal);
  }

  addAuthorization(additions: RuntimeHost[], scopes: LocalScope[], prepared?: PreparedContext & { text: string }): void {
    authorizeTaskInput(this.task, this.hosts, additions, scopes,
      (next) => this.effects.preparationSnapshot(next), (event: AppEvent) => this.signals.event(event), prepared);
  }

  inputSelected(input: import('@cloudhelm/core').QueuedSessionInput): Promise<void> { return this.inputQueue.selected(input); }

  inputDelivered(id: string, entryId: string): Promise<void> { return this.inputQueue.delivered(id, entryId); }

  inputHistoryAllowed(id: string): boolean { return this.inputQueue.allowsHistory(id); }

  stopInputQueue(): Promise<void> { return this.inputQueue.stop(); }

  get hasPendingInput(): boolean { return this.inputQueue.hasPending; }

  disposeInputQueue(): void { this.inputQueue.dispose(); }
}
