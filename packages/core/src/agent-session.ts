import type { ClarificationPort } from './clarification.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThinkingView { levels: ThinkingLevel[]; selected: ThinkingLevel; effective: ThinkingLevel; pending: boolean }

export interface SessionProfile {
  provider: string; modelId: string; baseUrl?: string; apiKey: string; credentialRevision?: string; jevKey?: string;
}
export interface BusinessTool<T = never> {
  name: string; label: string; description: string; parameters: object; replay: 'never';
  execute(id: string, args: T, signal?: AbortSignal): Promise<{
    content: Array<{ type: 'text'; text: string }>; details: unknown; isError?: boolean;
  }>;
}
export interface SessionStorage { directory: string; id: string; restore: boolean }
export interface ReasoningView {
  text: string; status: 'streaming' | 'complete' | 'interrupted' | 'unavailable';
  kind: 'thinking' | 'summary'; redacted?: boolean;
}
export interface ReasoningProgress { id: string; createdAt: number; model: { provider: string; modelId: string }; reasoning: ReasoningView }

export interface SessionText {
  reasoning?: ReasoningView;
  entryId: string; role: 'user' | 'agent' | 'system'; text: string; createdAt: number;
  model?: { provider: string; modelId: string };
}
export interface SessionUsage {
  model: { provider: string; modelId: string }; usedTokens: number | null; contextWindow: number | null;
  source: 'provider' | 'estimate' | 'unknown'; updatedAt: number;
}
export type SessionEvent =
  | { type: 'reasoning-progress'; value: ReasoningProgress | null }
  | { type: 'activity' }
  | { type: 'thinking'; value: ThinkingView }
  | { type: 'text'; value: SessionText }
  | { type: 'usage'; value: SessionUsage }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-end'; id: string; name: string; isError: boolean }
  | { type: 'response' }
  | { type: 'turn-end' }
  | { type: 'compaction'; status: 'running' | 'complete' | 'failed'; error?: string };
export interface SessionOptions {
  thinkingLevel?: ThinkingLevel; profile: SessionProfile; systemPrompt: string; tools: BusinessTool[];
  clarification: ClarificationPort; storage?: SessionStorage;
  assertActive(): void;
  beforeRequest(purpose: 'conversation' | 'compaction', profile: SessionProfile): void;
  event(event: SessionEvent): void;
}
/** SDK-neutral lifecycle; restoration never sends a prompt or executes tools. */
export interface ConversationSession {
  readonly isStreaming: boolean;
  readonly profile: SessionProfile;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  context(text: string): Promise<void>;
  select(profile: SessionProfile): void;
  setThinking(level: ThinkingLevel): void;
  setReviewKey(key?: string): void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  clearQueue(): void;
  dispose(): void;
}
