import { Type, type Static } from 'typebox';
import type { VerificationReport, VerificationState } from './verification-report.js';
export * from './verification-report.js';
export * from './request-budget.js';
export * from './execution-job.js';
export * from './agent-lifecycle.js';
export type { OperationLogPage } from './operation-log.js';
export * from './conversation-input.js';
import type { ExecutionJobView } from './execution-job.js';
export * from './request-budget-runtime.js';
export * from './host-settings.js';
import { SshConnectionSettingsSchema, type HostCredentialsPatch } from './host-settings.js';

export const HostDraftSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  address: Type.String({ minLength: 1, maxLength: 255 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  username: Type.String({ minLength: 1, maxLength: 128 }),
  auth: Type.Union([Type.Literal('agent'), Type.Literal('private-key'), Type.Literal('password')]),
  privateKeyPath: Type.Optional(Type.String()),
  jumpHostId: Type.Optional(Type.String()),
  group: Type.Optional(Type.String({ maxLength: 80 })),
  notes: Type.Optional(Type.String({ maxLength: 4096 })),
  connection: Type.Optional(SshConnectionSettingsSchema)
});

export type HostDraft = Static<typeof HostDraftSchema>;
export interface HostConnectionTestInput { host: HostDraft; editingHostId?: string; secret?: string; credentials?: HostCredentialsPatch; trustRequestId?: string }
export type HostTestFailure = 'auth' | 'credentials' | 'agent' | 'key-file' | 'timeout' | 'network' | 'interactive' | 'unknown';
export type HostConnectionTestResult =
  | { status: 'success'; latencyMs: number }
  | { status: 'failed'; code: HostTestFailure; stage: 'host' | 'jump' }
  | { status: 'trust-required'; requestId: string; stage: 'host' | 'jump'; address: string; port: number;
    fingerprint: string; expectedFingerprint?: string; expiresAt: number };
export type ReviewMode = 'ask' | 'ai-review' | 'permissive' | 'preauthorized';
export type ReviewSelection = { kind: 'current' } | { kind: 'jev' } | { kind: 'model'; provider: string; modelId: string };
export interface ClarificationQuestion {
  id: string;
  prompt: string;
  options?: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
}
export interface ClarificationAnswer { id: string; value: string; custom?: boolean }
export interface ClarificationRequest {
  id: string; taskId: string; toolCallId: string; generation: string;
  questions: ClarificationQuestion[]; createdAt: number; expiresAt: number;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  answers?: ClarificationAnswer[];
}

export type TaskStatus = 'draft' | 'running' | 'waiting-review' | 'waiting-user' | 'human-control' | 'recovering' | 'paused' | 'answered' | 'failed';
/** Only these backend-owned reasons permit a host-initiated continuation. */
export type ResumeReason = 'verify' | 'report' | 'interrupted' | 'model' | 'budget-exhausted' | 'outbound-limit-exhausted';

/** Named recovery dispositions: `reject` keeps the block, `release` unlocks
 * without continuation, `accept-and-continue` also continues the conversation
 * once the continuation conditions hold. */
export type RecoveryActionKind = 'reject' | 'release' | 'accept-and-continue';

/**
 * How an uncertain remote outcome was resolved. It never rewrites the recorded
 * outcome: `evidence` observed the real result; `risk-accepted` means the user
 * explicitly took over an outcome that could not be proven after inspection.
 */
export interface OperationReconciliation {
  kind: 'evidence' | 'risk-accepted';
  /** Observed result, only for kind `evidence`. */
  outcome?: 'succeeded' | 'failed';
  /** Newer successful inspection operations from the same host, only for kind `evidence`. */
  evidenceOperationIds?: string[];
  /** Conversation from which the user initiated recovery, if any. */
  sourceTaskId?: string;
  /** Named disposition that produced a `risk-accepted` release; audit only. */
  action?: RecoveryActionKind;
  explanation: string;
  at: number;
}

/** Durable audit and idempotency record of the unified recovery use case; the
 * latest decision wins and a rejection never releases the write lock. */
export interface RecoveryDecisionRecord {
  version: 1;
  actionId: string;
  action: RecoveryActionKind;
  at: number;
  sourceTaskId?: string;
  explanation?: string;
  /** Whether the write lock was durably released by this decision. */
  released: boolean;
  /** Whether the conversation continuation was dispatched. */
  resumed: boolean;
  resumeNote?: string;
  /** Terminal error recorded when the action stayed unresolved after persistence. */
  error?: string;
}

export interface RecoveryActionRequest {
  /** Client-generated idempotency key; replays return the recorded outcome without re-execution. */
  actionId: string;
  action: RecoveryActionKind;
  operationId: string;
  explanation?: string;
  sourceTaskId?: string;
  evidenceOperationIds?: string[];
}

export interface RecoveryActionOutcome {
  actionId: string;
  action: RecoveryActionKind;
  released: boolean;
  resumed: boolean;
  note?: string;
}

/** Statuses in which a conversation still owns live work and must not be deleted. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['running', 'waiting-review', 'waiting-user', 'human-control', 'recovering'];
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThinkingView { levels: ThinkingLevel[]; selected: ThinkingLevel; effective: ThinkingLevel; pending: boolean }

export interface ModelChoice { provider: string; modelId: string }
export interface ContextBudgetView {
  pendingInputReserve?: number;
  contextWindow: number; usedTokens: number; outputReserve: number; safetyMargin: number; availableInput: number;
  source: 'provider' | 'estimate';
}
export interface ModelCapacityView { contextWindow: number; maxOutputTokens: number; source: 'catalog' | 'custom-settings' }
export interface ContextUsageView {
  capacity?: ModelCapacityView;
  budget?: ContextBudgetView;
  model: ModelChoice;
  request: number;
  usedTokens: number | null;
  contextWindow: number | null;
  source: 'provider' | 'estimate' | 'unknown';
  updatedAt: number;
}
export interface ModelProfileDraft extends ModelChoice { baseUrl?: string; apiKey?: string; contextWindow?: number; maxTokens?: number }
export interface PlanStep { id: string; title: string; status: 'pending' | 'running' | 'done' | 'blocked' }
export type InterruptionSource = 'stop-button' | 'ctrl-c' | 'terminal-close';
export interface UserInterruption { source: InterruptionSource; requestedAt: number; operationIds: string[] }
export interface ReasoningView {
  text: string; status: 'streaming' | 'complete' | 'interrupted' | 'unavailable';
  kind: 'thinking' | 'summary'; redacted?: boolean;
}
export interface ReasoningProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; reasoning: ReasoningView }
export interface TextProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; text: string }

export interface ConversationMessage {
  source?: 'input' | 'clarification' | 'assistant';
  clarificationToolCallId?: string;
  document?: import('./message-content.js').MessageDocument;
  reasoning?: ReasoningView; entryId?: string; interruption?: UserInterruption; taskId: string; role: 'agent' | 'user' | 'system'; text: string; createdAt: number; model?: ModelChoice }
export interface TerminalViewState { cwd?: string; cwdUpdatedAt?: number; id: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed'; replacementTerminalId?: string }
export interface ConversationStart { thinkingLevel?: ThinkingLevel; hostId: string | null; message: string; model?: ModelChoice; localSelectionTokens: string[] }
export interface LocalScope { path: string; kind: 'file' | 'directory' }

export interface HostView extends HostDraft {
  id: string;
  archived?: boolean;
  previousHostId?: string;
  /** Backend-owned association with another record declaring the same login target. */
  riskPeerHostId?: string;
  fingerprint?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'changed-key' | 'error';
  protectedPaths: string[];
  protectedReadPaths?: string[];
  protectedWritePaths?: string[];
  /** User-declared pre-authorization scope for defaultMode 'preauthorized';
   * backend contract data, editing UI is intentionally not part of it. */
  preauthorization?: import('./host-settings.js').PreauthorizationScope;
  defaultMode: ReviewMode;
  policyRevision: number;
}

export const TaskIntentStateSchema = Type.Object({
  version: Type.Literal(1), revision: Type.Integer({ minimum: 0 }),
  originalGoal: Type.String(), currentInput: Type.String(),
  origin: Type.Union([Type.Literal('explicit'), Type.Literal('legacy')]),
  lastInputId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  // IDs already merged in this intent round; native UI replay never adds entries.
  clarifications: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), text: Type.String() }))
});
export type TaskIntentState = Static<typeof TaskIntentStateSchema>;

/** Versioned per-host logical working context. The default working directory survives
 * restarts only through this record; login observations and explicit actions are both
 * confirmed before the default is trusted, and an unconfirmed default is never a fallback. */
export interface LogicalHostContext {
  version: 1;
  hostId: string;
  loginAs: string;
  /** Last confirmed default working directory; null means unconfirmed, never "use home". */
  defaultCwd: string | null;
  revision: number;
  source: 'login-observed' | 'explicit';
  /** Set only after a rebuild re-verification of a persisted record. */
  restoreStatus?: 'restored' | 'unverified';
  updatedAt: number;
}

/** Idempotent per-host merge for persisted logical contexts; a redelivered or stale
 * record never rewrites a newer confirmed revision. Returns the existing array when
 * nothing changed, so callers can skip persistence. */
export function mergeLogicalContext(existing: LogicalHostContext[] | undefined, next: LogicalHostContext): LogicalHostContext[] {
  const current = existing?.find((context) => context.hostId === next.hostId);
  if (current && (current.revision > next.revision
    || (current.revision === next.revision && current.updatedAt >= next.updatedAt))) return existing ?? [];
  return [...(existing ?? []).filter((context) => context.hostId !== next.hostId), structuredClone(next)];
}

/** §7.1 evidence classification of one operation at the moment a connection was lost.
 * The record is loss-time evidence and is never revised by later observations. */
export type ConnectionLossClassification = 'not-handed-off' | 'observed-complete' | 'handed-off-or-unclear';

export interface ConnectionLossOperation {
  operationId: string;
  classification: ConnectionLossClassification;
  /** Read-only losses add no business write lock; re-issuing them carries no mutation risk. */
  readOnly?: boolean;
}

export interface ConnectionLossRecord {
  version: 1;
  hostId: string;
  lostAt: number;
  operations: ConnectionLossOperation[];
}

/** Appends one loss record per event; redelivery of the same (host, loss) is idempotent
 * and only the eight most recent records are kept. Returns the existing array when
 * nothing changed, so callers can skip persistence. */
export function mergeConnectionLosses(existing: ConnectionLossRecord[] | undefined, next: ConnectionLossRecord): ConnectionLossRecord[] {
  const current = existing ?? [];
  if (current.some((record) => record.hostId === next.hostId && record.lostAt === next.lostAt)) return current;
  const merged = [...current, structuredClone(next)];
  return merged.length > 8 ? merged.slice(merged.length - 8) : merged;
}

export interface TaskView {
  budget?: import('./request-budget.js').RequestBudgetState;
  intent?: TaskIntentState;
  thinking?: ThinkingView;
  /** Durable user preference; runtime observations must not replace it. */
  preferredThinking?: ThinkingLevel;
  session?: { version: 1; id: string };
  id: string;
  goal: string;
  hostIds: string[];
  reviewModesByHost?: Record<string, ReviewMode>;
  reviewRevision?: number;
  /** Per-host logical working context; the only path by which a default cwd survives restarts. */
  logicalContexts?: LogicalHostContext[];
  /** §7.1 loss-time evidence records; feeds the rebuilt-connection recovery report. */
  connectionLosses?: ConnectionLossRecord[];
  localScopes: LocalScope[];
  status: TaskStatus;
  resumeReason?: ResumeReason;
  modelId: string;
  provider?: string;
  credentialRevision?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  plan?: PlanStep[];
  report?: VerificationReport;
  verificationState?: VerificationState;
  verificationRound?: import('./verification-v3.js').VerificationRound;
  /** Recent report revisions; the complete archive is persisted separately. */
  verificationHistory?: VerificationReport[];
  requestCount: number;
  requestLimit: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
}

export * from './read-audit.js';
export * from './operation-impact.js';

export interface OperationView {
  fileRecovery?: import('./file-transaction.js').FileRecoveryView;
  /** Prompt guidance version in effect when the model proposed this operation; audit replay metadata only, never authorization. */
  promptVersion?: string;
  /** Optional versioned facts. Missing legacy facts remain unknown, never permissions. */
  impactAnalysis?: import('./operation-impact.js').OperationImpactView;
  /** Durable read decisions share the operation journal; metadata only. */
  readAudit?: import('./read-audit.js').RemoteReadAudit;
  /** Versioned backend process observation, independent of model settlement. */
  executionJob?: ExecutionJobView;
  processControl?: { kind: 'interrupt'; jobId: string; targetOperationId: string; pid?: number; processSequence?: number;
    connectionId?: string; delivery?: 'sent' | 'already-exited' | 'unknown' };
  /** Optional v1 JSON metadata; legacy records remain unknown, never relabelled on reconnect. */
  executionContext?: { version: 1; connectionId: string; terminalId: string; terminalGeneration: number };
  /** Capability verified from the full operation before execution, not from its display preview. */
  readOnly?: boolean;
  ruleId?: string;
  manualReviewAvailable?: boolean;
  reconciledAt?: number;
  reconciliation?: OperationReconciliation;
  /** Latest explicit recovery decision from the unified use case; audit and idempotency, never a permission. */
  recoveryDecision?: RecoveryDecisionRecord;
  intentKey?: string;
  /** Backend preflight whose result is not a user-visible business step. */
  internal?: 'identity-probe' | 'recovery-probe';
  /** For `internal: 'recovery-probe'`: the id of the unknown operation this probe serves. */
  recoveryProbeTarget?: string;
  /** Orchestration-level delegation identity: one id per delegated work unit, set by the backend. */
  delegationId?: string;
  /** Model-facing tool-call trace when the model initiated the delegation. */
  toolCallId?: string;
  verificationSource?: import('./verification-v3.js').VerificationSource;
  outputExpectation?: import('./verification-v3.js').OutputExpectation;
  /** Present when the allowance came from the user-declared pre-authorization
   * scope; audit projection only, never a replayable grant. */
  decisionSource?: 'user-preauthorization';
  preauthorizationMatch?: string;
  autoAdjudicated?: true;
  /** Backend observed a terminal completion/code, never reconciliation prose; launch failure may still mean the payload did not start. */
  exitObserved?: boolean;
  completedAt?: number;
  /** Directory captured with the full command fingerprint, never inferred from a display preview. */
  commandSource?: { version: 1; cwd: string };
  /** Reviewed backend transport; missing historical records remain unknown. */
  executionChannel?: 'native-exec' | 'native-pty' | 'native-background';
  serviceUnit?: string;
  authentication?: 'succeeded' | 'required' | 'failed';
  authenticationAttempts?: number;
  privilege?: import('./privilege.js').PrivilegeFeedbackView;
  failureKind?: 'authentication-required' | 'permission-denied' | 'authentication-failed' | 'unsupported' | 'user-action-required' | 'unresolved-prior-operation' | 'not-dispatched' | 'unknown';
  effects?: 'none' | 'possible' | 'observed-change';
  loginAs?: string;
  runAs?: string;
  interruption?: UserInterruption;
  id: string;
  taskId: string;
  hostId: string;
  kind: 'command' | 'write-file' | 'upload' | 'delete-path' | 'read-file' | 'inspect-file' | 'list-recovery' | 'cleanup-recovery';
  preview: string;
  status: 'proposed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'denied' | 'unknown';
  reason?: string;
  exitCode?: number;
  logRef?: string;
  outputTail?: string;
  outputCapture?: { totalChars: number; tailChars: number; truncated: boolean };
  model?: ModelChoice;
  createdAt: number;
}

/** Outcome fields the write-lock and recovery rules reason about. */
export type OperationOutcomeState = Pick<OperationView, 'readOnly' | 'status' | 'effects' | 'reconciledAt'>;

/**
 * True while a non-read-only operation's recorded remote outcome still gates
 * host writes and blocks acceptance. In-flight operations count as unresolved:
 * they are never resolved by guessing, only by their real completion.
 * HostSerialExecutor applies the same verdict to a fresh OperationResult
 * (unknown / handed-over / failed without effects:'none'), so one fact cannot
 * unlock now and lock again after a restart.
 */
export function operationNeedsVerification(operation: OperationOutcomeState): boolean {
  if (operation.readOnly || operation.reconciledAt) return false;
  return ['proposed', 'approved', 'running', 'unknown'].includes(operation.status)
    || (operation.status === 'failed' && operation.effects !== 'none');
}

/**
 * True when the outcome is terminal-unknown and may be resolved either by fresh
 * same-host evidence or by an explicit user risk acceptance. Running operations
 * are excluded: the user cannot accept an outcome that is still being produced.
 */
export function operationOutcomeResolvable(operation: OperationOutcomeState): boolean {
  if (operation.readOnly || operation.reconciledAt) return false;
  return operation.status === 'unknown' || (operation.status === 'failed' && operation.effects !== 'none');
}

/** First persisted resolution wins; delayed snapshots can still add real observations. */
export function retainOperationResolution(previous: OperationView | undefined, incoming: OperationView): OperationView {
  if (!previous) return incoming;
  if (previous.id !== incoming.id || previous.taskId !== incoming.taskId
    || previous.hostId !== incoming.hostId || previous.kind !== incoming.kind) {
    throw new Error('Operation identity changed while applying an observation');
  }
  if (!previous.reconciledAt) return incoming;
  // Never erase an acceptance or replace it with a competing assessment, nor
  // drop the full source/evidence audit metadata from the canonical record.
  if (incoming.reconciledAt && (incoming.reconciledAt !== previous.reconciledAt
    || incoming.reconciliation?.kind !== previous.reconciliation?.kind
    || incoming.reconciliation?.outcome !== previous.reconciliation?.outcome)) return previous;
  return { ...incoming, reconciledAt: previous.reconciledAt, reconciliation: previous.reconciliation };
}

export interface ApprovalView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  fingerprint: string;
  title: string;
  explanation: string;
  account?: string;
  cwd?: string;
  impact?: 'ordinary' | 'high' | 'unknown';
  targets?: string[];
  recovery?: string;
  preview: string;
  expiresAt: number;
  /** Absolute renewal ceiling enforced by the worker server. */
  hardExpiresAt?: number;
  /** Renewals already consumed from the allowed maximum. */
  renewals?: number;
}

export interface InputRequestView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  title: string;
  explanation: string;
  kind: 'confirmation' | 'text' | 'secret' | 'otp';
  choices?: string[];
  expiresAt: number;
}

export interface ExecutionView {
  model: 'running' | 'idle';
  remote: 'running' | 'unknown' | 'idle';
  stopping: boolean;
  canStop: boolean;
}

export { sharesHostRiskDomain, type HostRiskBindingView } from './host-risk.js';

export interface AppSnapshot {
  hostRiskBindings?: import('./host-risk.js').HostRiskBindingView[];
  agentActivity?: Record<string, import('./agent-lifecycle.js').AgentActivityView>;
  queuedInputs?: import('./conversation-input.js').ConversationInputView[];
  reasoningProgress?: Record<string, ReasoningProgress>;
  textProgress?: Record<string, TextProgress>;
  execution?: Record<string, ExecutionView>;
  contextUsage?: Record<string, ContextUsageView>;
  contextCompaction?: Record<string, 'running' | 'complete' | 'failed'>;
  hosts: HostView[];
  conversations: TaskView[];
  terminals: TerminalViewState[];
  operations: OperationView[];
  approvals: ApprovalView[];
  inputs: InputRequestView[];
  clarifications?: ClarificationRequest[];
  messages: ConversationMessage[];
  profile: { provider: string; modelId: string; baseUrl?: string; hasKey: boolean; hasJevKey: boolean; reviewer?: ReviewSelection };
}

export interface ModelProviderView {
  id: string;
  name: string;
  defaultBaseUrl?: string;
  models: Array<{ id: string; name: string }>;
}

export interface ModelProviderSettings {
  modelId?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  hasKey: boolean;
}

export interface HostCapabilityProfile {
  version: 1;
  hostId: string;
  /** Must match the trusted host key before main persists a worker observation. */
  hostFingerprint: string;
  loginAs: string;
  connectionId: string;
  observedAt: number;
  data: {
    os: string | null; distribution: string | null; version: string | null;
    architecture: string | null; architectureFamily: string | null; kernel: string | null;
    username: string | null; uid: number | null; loginDirectory: string | null;
    path: string | null; toolPresence: Record<string, boolean>; source: 'python' | 'shell';
  };
}

export type AppEvent =
  | { type: 'agent-lifecycle'; taskId: string; value: import('./agent-lifecycle.js').AgentLifecycleObservation }
  | { type: 'terminal-cwd'; terminalId: string; directory: string; updatedAt: number }
  | { type: 'host-capability-observed'; value: HostCapabilityProfile }
  | { type: 'terminal-command'; terminalId: string; generation: number; phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }
  | { type: 'message-preparation'; requestId: string; referenceId?: string; status: 'checking' | 'compressing' | 'ready'; context?: ContextUsageView; summaryRequests?: { used: number; limit: 32 } }
  | { type: 'reasoning-progress'; taskId: string; value: ReasoningProgress | null }
  | { type: 'text-progress'; taskId: string; value: TextProgress | null }
  | { type: 'thinking'; taskId: string; value: ThinkingView }
  | { type: 'execution'; taskId: string; value: ExecutionView }
  | { type: 'context-usage'; taskId: string; value: ContextUsageView }
  | { type: 'clarification'; value: ClarificationRequest }
  | { type: 'task-intent'; taskId: string; value: TaskIntentState }
  | { type: 'logical-context'; taskId: string; value: LogicalHostContext }
  | { type: 'connection-loss'; taskId: string; value: ConnectionLossRecord }
  | { type: 'snapshot'; value: AppSnapshot }
  | { type: 'terminal-data'; terminalId: string; data: string; operationId?: string }
  | { type: 'terminal-state'; terminalId: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed' }
  | { type: 'terminal-replaced'; previousTerminalId: string; terminalId: string }
  | ({ type: 'task-message' } & ConversationMessage)
  | { type: 'context-compaction'; taskId: string; status: 'running' | 'complete' | 'failed' }
  | { type: 'model-request'; purpose?: 'conversation' | 'compaction'; roundId?: string; logicalRequestId?: string; attempt?: number;
      transport?: 'http' | 'opaque'; taskId: string; model: ModelChoice; request: number; createdAt: number }
  | { type: 'work-progress'; taskId: string; plan: PlanStep[] }
  | { type: 'work-report'; taskId: string; report?: VerificationReport }
  | { type: 'verification-state'; taskId: string; value?: VerificationState }
  | { type: 'verification-round'; taskId: string; value: import('./verification-v3.js').VerificationRound };

export interface ShortcutSettings { bindings: Record<string, string>; enabled: boolean }

/** User-selected theme; 'system' follows the OS preference. */
export interface StoredAppearanceSettings { mode: 'system' | 'light' | 'dark' }

/** Persisted UI layout; 'ssh' keeps the terminal-first workspace. */
export interface StoredLayoutSettings { mode: 'ssh' | 'agent' }

export interface DesktopAPI {
  openReferenceDraft(scope: import('./message-content.js').ReferenceDraftScope): Promise<string>;
  claimDraftReferences(draftId: string, referenceIds: string[]): Promise<void>;
  releaseReferenceDraft(draftId: string): Promise<void>;
  quoteTerminal(input: import('./message-content.js').TerminalQuoteRequest): Promise<import('./message-content.js').ReferenceInfo>;
  readReference(id: string): Promise<import('./message-content.js').ReferenceBody>;
  sendStructured(input: import('./message-content.js').StructuredSend): Promise<{ conversationId: string }>;
  cancelMessage(requestId: string): Promise<void>;

  snapshot(): Promise<AppSnapshot>;
  /** Version of the packaged application, sourced from apps/desktop/package.json. */
  appVersion(): Promise<string>;
  addHost(host: HostDraft, credentials?: HostCredentialsPatch): Promise<HostView>;
  editHost(hostId: string, host: HostDraft, newSecret?: string, credentials?: HostCredentialsPatch): Promise<HostView>;
  testHostConnection(input: HostConnectionTestInput): Promise<HostConnectionTestResult>;
  setHostSecret(hostId: string, secret: string): Promise<void>;
  updateHostReviewMode(hostId: string, mode: ReviewMode): Promise<void>;
  updateHostSafety(hostId: string, mode: ReviewMode, protectedReadPaths: string[], protectedWritePaths: string[]): Promise<void>;
  updateConversationReviewMode(taskId: string, hostId: string, mode: ReviewMode): Promise<void>;
  requestAiDenialReview(taskId: string, operationId: string): Promise<void>;
  readRecoveryOperationLog(operationId: string, cursor: number): Promise<{ text: string; nextCursor: number; more: boolean }>;
  resolveOperationRisk(request: RecoveryActionRequest): Promise<RecoveryActionOutcome>;
  listModelProviders(): Promise<ModelProviderView[]>;
  modelProviderSettings(providerId: string): Promise<ModelProviderSettings>;
  saveModelProfile(profile: ModelProfileDraft): Promise<void>;
  testModelConnection(profile: ModelProfileDraft): Promise<{ latencyMs: number }>;
  /** Actual outbound request ledger shared by conversation, compaction, summary,
   * review and connection tests; used is monotonic, cap null means unlimited. */
  outboundLimit(): Promise<{ used: number; cap: number | null }>;
  saveOutboundLimit(cap: number | null): Promise<{ used: number; cap: number | null }>;
  availableModels(): Promise<Array<ModelChoice & { name: string; thinkingLevels?: ThinkingLevel[] }>>;
  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean; reviewer?: ReviewSelection }): Promise<void>;
  shortcuts(): Promise<ShortcutSettings>;
  saveShortcuts(settings: ShortcutSettings): Promise<void>;
  appearanceSettings(): Promise<StoredAppearanceSettings>;
  saveAppearanceSettings(settings: StoredAppearanceSettings): Promise<void>;
  layoutSettings(): Promise<StoredLayoutSettings>;
  saveLayoutSettings(settings: StoredLayoutSettings): Promise<void>;
  /** Clipboard access for user-initiated menu actions; contents are never logged. */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  connectHost(hostId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  deleteHost(hostId: string): Promise<void>;
  trustHostKey(hostId: string, fingerprint: string): Promise<void>;
  openTerminal(hostId: string): Promise<string>;
  closeTerminal(terminalId: string): Promise<void>;
  selectLocalPath(kind: LocalScope['kind']): Promise<{ token: string; scope: LocalScope } | null>;
  selectPrivateKey(): Promise<string | null>;
  terminalInput(terminalId: string, data: string): Promise<void>;
  terminalProtocolResponse(terminalId: string, data: string): Promise<void>;
  stopTerminal(terminalId: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  startConversation(input: ConversationStart): Promise<TaskView>;
  sendMessage(conversationId: string, message: string, localSelectionTokens?: string[], queueMode?: import('./conversation-input.js').ConversationInputKind): Promise<void>;
  cancelQueuedInput?(conversationId: string, inputId: string): Promise<{ cancelled: boolean }>;
  setConversationThinking(conversationId: string, level: ThinkingLevel): Promise<void>;
  setConversationModel(conversationId: string, model: ModelChoice): Promise<void>;
  answerClarification(taskId: string, requestId: string, answers: ClarificationAnswer[]): Promise<void>;
  cancelClarification(taskId: string, requestId: string): Promise<void>;
  stopOperation(conversationId: string): Promise<void>;
  decideApproval(approvalId: string, approved: boolean): Promise<void>;
  renewApproval(approvalId: string): Promise<{ expiresAt: number; hardExpiresAt: number }>;
  answerInput(requestId: string, answer: string): Promise<void>;
  cancelInput(requestId: string): Promise<void>;
  pauseConversation(taskId: string): Promise<void>;
  resumeConversation(taskId: string): Promise<void>;
  /** Re-project a settled automatic report from existing records only; no SSH/model execution. */
  rebuildVerificationReport(taskId: string): Promise<void>;
  extendRequestBudget(input: import('./request-budget.js').ExtendRequestBudget): Promise<import('./request-budget.js').BudgetExtensionResult>;
  listRemote(hostId: string, path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  readTerminalLog(terminalId: string): Promise<string>;
  readOperationLog?(taskId: string, operationId: string, cursor: number): Promise<import('./operation-log.js').OperationLogPage>;
  /** Permanently removes a finished conversation with its records and terminal logs. */
  deleteConversation(id: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export * from './message-content.js';
