import type { ClarificationPort } from './clarification.js';
import type { ModelRequestAttempt } from './request-budget.js';
import type { ContextBudget } from './context-budget.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThinkingView { levels: ThinkingLevel[]; selected: ThinkingLevel; effective: ThinkingLevel; pending: boolean }

export interface SessionProfile {
  provider: string; modelId: string; baseUrl?: string; contextWindow?: number; maxTokens?: number;
  apiKey: string; credentialRevision?: string; jevKey?: string;
}
export interface BusinessTool<T = never> {
  name: string; label: string; description: string; parameters: object; replay: 'never';
  /** Explicit query capability, never inferred from annotations or a command string. Defaults to model-only. */
  access?: 'query' | 'model-only';
  deferred?: boolean;
  /** Offline authorization projection for discovery; execute must still recheck its recipient. */
  available?(): boolean;
  execute(id: string, args: T, signal?: AbortSignal): Promise<{
    content: Array<{ type: 'text'; text: string }>; details: unknown; isError?: boolean;
    /** Explicit public data only. Private renderer details are never promoted automatically. */
    structuredContent?: unknown;
  }>;
}
export interface SessionStorage { directory: string; id: string; restore: boolean }
export interface ReasoningView {
  text: string; status: 'streaming' | 'complete' | 'interrupted' | 'unavailable';
  kind: 'thinking' | 'summary'; redacted?: boolean;
}
export interface ReasoningProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; reasoning: ReasoningView }
export interface TextProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; text: string }

export interface SessionText {
  /** Provenance from the native entry, not inferred from its displayed text. */
  source?: 'input' | 'clarification' | 'assistant';
  clarificationToolCallId?: string;
  document?: import('./message-content.js').MessageDocument;
  reasoning?: ReasoningView;
  entryId: string; role: 'user' | 'agent' | 'system'; text: string; createdAt: number;
  model?: { provider: string; modelId: string };
}
export interface SessionCapacity { contextWindow: number; maxOutputTokens: number; source: 'catalog' | 'custom-settings' }
export interface SessionUsage {
  capacity?: SessionCapacity;
  /** Shared preparation policy, separate from legacy raw usage reporting. */
  budget?: ContextBudget;
  model: { provider: string; modelId: string }; usedTokens: number | null; contextWindow: number | null;
  source: 'provider' | 'estimate' | 'unknown'; updatedAt: number;
}
export type SessionEvent =
  | { type: 'lifecycle'; value: import('./agent-lifecycle.js').AgentLifecycleObservation }
  | { type: 'reasoning-progress'; value: ReasoningProgress | null }
  | { type: 'text-progress'; value: TextProgress | null }
  | { type: 'activity' }
  | { type: 'thinking'; value: ThinkingView }
  | { type: 'text'; value: SessionText }
  | { type: 'usage'; value: SessionUsage }
  | { type: 'tool-start'; id: string; name: string; args: unknown; parentToolCallId?: string }
  | { type: 'tool-end'; id: string; name: string; isError: boolean; parentToolCallId?: string; durationMs?: number }
  | { type: 'response'; attempt?: ModelRequestAttempt; status?: string }
  | { type: 'turn-end' }
  | { type: 'compaction'; status: 'running' | 'complete' | 'failed'; error?: string };
export type QueuedSessionInput = Pick<import('./conversation-input.js').ConversationInput, 'id' | 'kind' | 'text' | 'document'>;
export interface SessionOptions {
  inputSelected?(input: QueuedSessionInput): void | Promise<void>;
  inputDelivered?(id: string, entryId: string): void | Promise<void>;
  inputHistoryAllowed?(id: string): boolean;
  /** Validates bounded query-cache references only; never grants tool execution. */
  queryReferenceAllowed?(id: string): boolean;
  thinkingLevel?: ThinkingLevel; profile: SessionProfile; systemPrompt: string; tools: BusinessTool[];
  /** Backend-owned, per-request system prompt projection; never derive it from conversation messages. */
  currentSystemPrompt?(): string;
  clarification: ClarificationPort; storage?: SessionStorage;
  assertActive(): void;
  /** Backend policy/control revision; a change invalidates pending HTTP retries. */
  requestGeneration?(): string;
  /** HTTP fetch or conservative opaque-route reservation; rejection sends nothing. */
  beforeRequest(purpose: 'conversation' | 'compaction', profile: SessionProfile,
    attempt: ModelRequestAttempt, signal?: AbortSignal): void | Promise<void>;
  event(event: SessionEvent): void;
}
/** Backend-issued preparation capability, never exposed as an agent tool.
 * Authorization and a durable main-round reservation are mandatory per attempt. */
export interface IdleCompactionLease {
  signal: AbortSignal;
  assertValid(): void;
  reserve(profile: SessionProfile, attempt: ModelRequestAttempt, signal?: AbortSignal): void | Promise<void>;
}
export interface SessionContextSnapshot { budget: ContextBudget; historyTokens: number; hasHistory: boolean; revision: string }
/** SDK-neutral lifecycle; restoration never sends a prompt or executes tools. */
export interface ConversationSession {
  readonly isStreaming: boolean;
  /** True only when the most recently settled turn ended in a complete, nonempty assistant answer. */
  readonly lastTurnAnswered: boolean;
  readonly profile: SessionProfile;
  contextTokens?(): number;
  /** Optional backend-only prompt preview estimates prospective authorization without granting it. */
  contextSnapshot?(systemPrompt?: string): SessionContextSnapshot;
  compactIdle?(lease: IdleCompactionLease): Promise<void>;
  prompt(text: string, document?: import('./message-content.js').MessageDocument): Promise<void>;
  /** Host-initiated continuation, never projected as a user message. */
  resumeWithContext(text: string): Promise<void>;
  steer(text: string, document?: import('./message-content.js').MessageDocument): Promise<void>;
  queueInput?(input: QueuedSessionInput): void;
  cancelQueuedInput?(id: string): boolean;
  context(text: string): Promise<void>;
  select(profile: SessionProfile): void;
  setThinking(level: ThinkingLevel): void;
  setReviewKey(key?: string): void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  clearQueue(): void;
  dispose(): void;
}
