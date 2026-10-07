import { Type, type Static } from 'typebox';

export const HostDraftSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  address: Type.String({ minLength: 1, maxLength: 255 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  username: Type.String({ minLength: 1, maxLength: 128 }),
  auth: Type.Union([Type.Literal('agent'), Type.Literal('private-key'), Type.Literal('password')]),
  privateKeyPath: Type.Optional(Type.String()),
  jumpHostId: Type.Optional(Type.String())
});

export type HostDraft = Static<typeof HostDraftSchema>;
export interface HostConnectionTestInput { host: HostDraft; editingHostId?: string; secret?: string; trustRequestId?: string }
export type HostTestFailure = 'auth' | 'credentials' | 'agent' | 'key-file' | 'timeout' | 'network' | 'interactive' | 'unknown';
export type HostConnectionTestResult =
  | { status: 'success'; latencyMs: number }
  | { status: 'failed'; code: HostTestFailure; stage: 'host' | 'jump' }
  | { status: 'trust-required'; requestId: string; stage: 'host' | 'jump'; address: string; port: number;
    fingerprint: string; expectedFingerprint?: string; expiresAt: number };
export type ReviewMode = 'ask' | 'ai-review' | 'permissive';
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

export type TaskStatus = 'draft' | 'running' | 'waiting-review' | 'waiting-user' | 'human-control' | 'recovering' | 'paused' | 'answered' | 'ready-for-review' | 'accepted' | 'failed';

/** Statuses in which a conversation still owns live work and must not be deleted. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['running', 'waiting-review', 'waiting-user', 'human-control', 'recovering', 'answered'];
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export interface ModelChoice { provider: string; modelId: string }
export interface ModelProfileDraft extends ModelChoice { baseUrl?: string; apiKey?: string }
export interface PlanStep { id: string; title: string; status: 'pending' | 'running' | 'done' | 'blocked' }
export interface VerificationReport { summary: string; access: string[]; evidenceOperationIds: string[]; changes: string[]; recovery: string[] }
export type InterruptionSource = 'stop-button' | 'ctrl-c' | 'terminal-close';
export interface UserInterruption { source: InterruptionSource; requestedAt: number; operationIds: string[] }
export interface ConversationMessage { interruption?: UserInterruption; taskId: string; role: 'agent' | 'user' | 'system'; text: string; createdAt: number; model?: ModelChoice }
export interface TerminalViewState { id: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed'; replacementTerminalId?: string }
export interface ConversationStart { hostId: string | null; message: string; model?: ModelChoice; localSelectionTokens: string[] }
export interface LocalScope { path: string; kind: 'file' | 'directory' }

export interface HostView extends HostDraft {
  id: string;
  archived?: boolean;
  previousHostId?: string;
  fingerprint?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'changed-key' | 'error';
  protectedPaths: string[];
  defaultMode: ReviewMode;
  policyRevision: number;
}

export interface TaskView {
  id: string;
  goal: string;
  hostIds: string[];
  localScopes: LocalScope[];
  status: TaskStatus;
  modelId: string;
  provider?: string;
  credentialRevision?: string;
  baseUrl?: string;
  plan?: PlanStep[];
  report?: VerificationReport;
  requestCount: number;
  requestLimit: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
}

export interface OperationView {
  authentication?: 'succeeded' | 'required' | 'failed';
  authenticationAttempts?: number;
  failureKind?: 'authentication-required' | 'permission-denied' | 'authentication-failed' | 'unsupported' | 'user-action-required' | 'unknown';
  effects?: 'none' | 'possible';
  loginAs?: string;
  runAs?: string;
  interruption?: UserInterruption;
  id: string;
  taskId: string;
  hostId: string;
  kind: 'command' | 'write-file' | 'upload' | 'delete-path';
  preview: string;
  status: 'proposed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'denied' | 'unknown';
  reason?: string;
  exitCode?: number;
  logRef?: string;
  outputTail?: string;
  model?: ModelChoice;
  createdAt: number;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  operationId: string;
  hostId: string;
  fingerprint: string;
  title: string;
  explanation: string;
  preview: string;
  expiresAt: number;
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

export interface AppSnapshot {
  hosts: HostView[];
  conversations: TaskView[];
  terminals: TerminalViewState[];
  operations: OperationView[];
  approvals: ApprovalView[];
  inputs: InputRequestView[];
  clarifications?: ClarificationRequest[];
  messages: ConversationMessage[];
  profile: { provider: string; modelId: string; baseUrl?: string; hasKey: boolean; hasJevKey: boolean };
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
  hasKey: boolean;
}

export type AppEvent =
  | { type: 'clarification'; value: ClarificationRequest }
  | { type: 'snapshot'; value: AppSnapshot }
  | { type: 'terminal-data'; terminalId: string; data: string; operationId?: string }
  | { type: 'terminal-state'; terminalId: string; hostId: string; taskId?: string; state: 'agent' | 'human' | 'suspended' | 'closed' }
  | { type: 'terminal-replaced'; previousTerminalId: string; terminalId: string }
  | ({ type: 'task-message' } & ConversationMessage)
  | { type: 'model-request'; taskId: string; model: ModelChoice; request: number; createdAt: number }
  | { type: 'work-progress'; taskId: string; plan: PlanStep[] }
  | { type: 'work-report'; taskId: string; report?: VerificationReport };

export interface ShortcutSettings { bindings: Record<string, string>; enabled: boolean }

export interface DesktopAPI {
  snapshot(): Promise<AppSnapshot>;
  /** Version of the packaged application, sourced from apps/desktop/package.json. */
  appVersion(): Promise<string>;
  addHost(host: HostDraft): Promise<HostView>;
  editHost(hostId: string, host: HostDraft, newSecret?: string): Promise<HostView>;
  testHostConnection(input: HostConnectionTestInput): Promise<HostConnectionTestResult>;
  setHostSecret(hostId: string, secret: string): Promise<void>;
  updateHostSafety(hostId: string, mode: ReviewMode, protectedPaths: string[]): Promise<void>;
  listModelProviders(): Promise<ModelProviderView[]>;
  modelProviderSettings(providerId: string): Promise<ModelProviderSettings>;
  saveModelProfile(profile: ModelProfileDraft): Promise<void>;
  testModelConnection(profile: ModelProfileDraft): Promise<{ latencyMs: number }>;
  availableModels(): Promise<Array<ModelChoice & { name: string }>>;
  saveReviewSettings(settings: { jevKey?: string; disableJev?: boolean }): Promise<void>;
  shortcuts(): Promise<ShortcutSettings>;
  saveShortcuts(settings: ShortcutSettings): Promise<void>;
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
  sendMessage(conversationId: string, message: string, localSelectionTokens?: string[]): Promise<void>;
  setConversationModel(conversationId: string, model: ModelChoice): Promise<void>;
  answerClarification(taskId: string, requestId: string, answers: ClarificationAnswer[]): Promise<void>;
  cancelClarification(taskId: string, requestId: string): Promise<void>;
  stopOperation(conversationId: string): Promise<void>;
  decideApproval(approvalId: string, approved: boolean): Promise<void>;
  answerInput(requestId: string, answer: string): Promise<void>;
  cancelInput(requestId: string): Promise<void>;
  pauseConversation(taskId: string): Promise<void>;
  resumeConversation(taskId: string): Promise<void>;
  acceptConversation(taskId: string): Promise<void>;
  listRemote(hostId: string, path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>;
  readTerminalLog(terminalId: string): Promise<string>;
  /** Permanently removes a finished conversation with its records and terminal logs. */
  deleteConversation(id: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
