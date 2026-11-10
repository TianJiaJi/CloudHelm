/** Observations only: never grants execution, clears risk, or proves remote exit. */
export interface RunObservation {
  kind: 'run'; runId: string; status: 'running' | 'settled'; startedAt: number; observedAt: number;
  aborted?: boolean; durationMs?: number;
}
export interface ToolObservation {
  kind: 'tool'; runId: string; callId: string; nativeId: string; name: string;
  parentCallId?: string; parentToolCallId?: string;
  status: 'running' | 'complete' | 'failed' | 'interrupted';
  startedAt: number; observedAt: number; updates: number; durationMs?: number;
}
export interface RequestObservation {
  kind: 'request'; logicalRequestId: string; attempt: number; purpose: 'conversation' | 'compaction' | 'summary' | 'review';
  provider: string; modelId: string; status: 'running' | 'complete' | 'failed' | 'aborted' | 'unknown';
  startedAt: number; observedAt: number; durationMs?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; source: 'provider' };
  cost?: { usd: number | null; source: 'provider' | 'estimate' | 'unknown' };
}
export type AgentLifecycleObservation = RunObservation | ToolObservation | RequestObservation;
