import { Type } from 'typebox';
import { Value } from 'typebox/value';

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

/** Bounded transient projection; durable operations/jobs remain the recovery authority. */
export interface AgentActivityView {
  version: 1; run?: RunObservation; runtimeLost?: boolean;
  tools: ToolObservation[]; requests: RequestObservation[]; omittedTools: number; omittedRequests: number;
}
const id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[a-zA-Z0-9_.:-]+$' });
const label = Type.String({ minLength: 1, maxLength: 200 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timing = { startedAt: counter, observedAt: counter, durationMs: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) };
const status = (...values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const schema = Type.Union([
  Type.Object({ kind: Type.Literal('run'), runId: id, status: status('running', 'settled'), aborted: Type.Optional(Type.Boolean()), ...timing }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('tool'), runId: id, callId: id, nativeId: id, name: label,
    parentCallId: Type.Optional(id), parentToolCallId: Type.Optional(id), updates: counter,
    status: status('running', 'complete', 'failed', 'interrupted'), ...timing }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('request'), logicalRequestId: id, attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    purpose: status('conversation', 'compaction', 'summary', 'review'), provider: label, modelId: label,
    status: status('running', 'complete', 'failed', 'aborted', 'unknown'), ...timing,
    tokens: Type.Optional(Type.Object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, source: Type.Literal('provider') }, { additionalProperties: false })),
    cost: Type.Optional(Type.Union([
      Type.Object({ usd: Type.Null(), source: Type.Literal('unknown') }, { additionalProperties: false }),
      Type.Object({ usd: Type.Number({ minimum: 0, maximum: Number.MAX_VALUE }), source: status('provider', 'estimate') }, { additionalProperties: false })
    ])) }, { additionalProperties: false })
]);
export function isAgentLifecycleObservation(value: unknown): value is AgentLifecycleObservation {
  if (!Value.Check(schema, value)) return false;
  const item = value as AgentLifecycleObservation;
  if (item.observedAt < item.startedAt) return false;
  if (item.kind === 'request' && item.tokens && item.tokens.input + item.tokens.output + item.tokens.cacheRead + item.tokens.cacheWrite === 0) return false;
  return true;
}
