import { currentToolOrigin, type ToolOrigin } from './pi-tool-origin.js';
import { createHash, randomUUID } from 'node:crypto';
import { redactOutput, type AgentLifecycleObservation, type ModelRequestAttempt, type RequestObservation, type RunObservation, type SessionProfile, type ToolObservation } from '@cloudhelm/core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';

/** Metadata-only observer. No arguments, partial results, credentials, or remote-state authority. */
export class PiLifecycle {
  private run?: RunObservation;
  private closed = false;
  private readonly calls = new Map<string, ToolObservation>();
  private readonly requests = new Map<string, RequestObservation>();
  constructor(private readonly emit: (value: AgentLifecycleObservation) => void, private readonly toolNames: ReadonlySet<string>) {}
  originFor(nativeId: string): ToolOrigin | undefined {
    const parent = this.calls.get(nativeId);
    return parent?.status === 'running' && parent.runId === this.run?.runId ? { runId: parent.runId, parentCallId: parent.callId } : undefined;
  }
  observe(event: AgentSessionEvent): void {
    if (this.closed) return;
    const now = Date.now();
    if (event.type === 'agent_start') {
      this.interruptCalls(now);
      this.run = { kind: 'run', runId: randomUUID(), status: 'running', startedAt: now, observedAt: now };
      this.publish(this.run);
    }
    if (event.type === 'agent_settled' && this.run?.status === 'running') {
      this.interruptCalls(now);
      this.run = { ...this.run, status: 'settled', aborted: event.aborted, observedAt: now, durationMs: Math.max(0, now - this.run.startedAt) };
      this.publish(this.run);
    }
    if (event.type === 'tool_execution_start' && this.run?.status === 'running') {
      if (this.calls.size >= 256) throw new Error('Tool observation capacity exhausted');
      const origin = currentToolOrigin();
      const parent = event.parentToolCallId ? this.calls.get(event.parentToolCallId) : undefined;
      if (event.parentToolCallId && (!origin || origin.runId !== this.run.runId || origin.parentCallId !== parent?.callId)) return;
      const previous = this.calls.get(event.toolCallId);
      if (previous) { previous.status = 'interrupted'; previous.observedAt = now; this.publish(previous); }
      const value: ToolObservation = { kind: 'tool', runId: this.run.runId, callId: randomUUID(), nativeId: event.toolCallId,
        name: event.toolName, parentToolCallId: event.parentToolCallId, parentCallId: parent?.callId,
        status: 'running', startedAt: now, observedAt: now, updates: 0 };
      this.calls.set(event.toolCallId, value);
      this.publish(value);
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      // End events have no args. The host's async scope binds nested callbacks across awaits,
      // even when a later run or parent reuses a model-supplied native call id.
      const value = this.calls.get(event.toolCallId), origin = currentToolOrigin();
      if (event.parentToolCallId && (!origin || value?.runId !== origin.runId || value.parentCallId !== origin.parentCallId)) return;
      if (!value || value.status !== 'running' || value.name !== event.toolName || value.runId !== this.run?.runId) return;
      if (event.type === 'tool_execution_update') {
        value.updates++;
        if (now - value.observedAt < 100) return;
      } else {
        value.status = event.isError ? 'failed' : 'complete';
        if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) value.durationMs = event.durationMs;
        this.calls.delete(event.toolCallId);
      }
      value.observedAt = now; this.publish(value);
    }
  }
  requestStarted(attempt: ModelRequestAttempt, profile: SessionProfile): void {
    if (this.closed) throw new Error('Model lifecycle closed');
    if (this.requests.size >= 8) throw new Error('Model observation capacity exhausted');
    const now = Date.now();
    const value: RequestObservation = { kind: 'request', logicalRequestId: attempt.logicalRequestId, attempt: attempt.attempt,
      purpose: attempt.purpose, provider: profile.provider, modelId: profile.modelId, status: 'running', startedAt: now, observedAt: now };
    this.requests.set(this.requestKey(attempt), value); this.publish(value);
  }
  requestFinished(attempt: Pick<ModelRequestAttempt, 'logicalRequestId' | 'attempt'>, message?: AssistantMessage, catalogPricing = false): void {
    const key = this.requestKey(attempt), value = this.requests.get(key);
    if (!value || this.closed) return;
    this.requests.delete(key);
    value.status = !message ? 'unknown' : message.stopReason === 'aborted' ? 'aborted' : ['error', 'length'].includes(message.stopReason) ? 'failed' : 'complete';
    value.observedAt = Date.now(); value.durationMs = Math.max(0, value.observedAt - value.startedAt);
    const usage = message?.usage;
    if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0)
      && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
      value.tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, source: 'provider' };
      // Pi calculates catalog costs; this is not a provider billing receipt. Custom zero prices are unknown.
      const cost = usage.cost?.total;
      value.cost = catalogPricing && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? { usd: cost, source: 'estimate' } : { usd: null, source: 'unknown' };
    } else value.cost = { usd: null, source: 'unknown' };
    this.publish(value);
  }
  close(): void {
    if (this.closed) return;
    this.interruptCalls(Date.now());
    for (const value of [...this.requests.values()]) this.requestFinished(value);
    this.closed = true; // Disposal is not a synthetic native agent_settled event.
  }
  private interruptCalls(now: number): void {
    for (const value of this.calls.values()) {
      value.status = 'interrupted'; value.observedAt = now; this.publish(value);
    }
    this.calls.clear();
  }
  private requestKey(attempt: Pick<ModelRequestAttempt, 'logicalRequestId' | 'attempt'>): string { return `${attempt.logicalRequestId}/${attempt.attempt}`; }
  private publish(value: AgentLifecycleObservation): void {
    const copy = structuredClone(value);
    if (copy.kind === 'tool') {
      const reference = (id: string) => `sha256:${createHash('sha256').update(id).digest('hex')}`;
      copy.nativeId = reference(copy.nativeId);
      if (copy.parentToolCallId) copy.parentToolCallId = reference(copy.parentToolCallId);
      if (!this.toolNames.has(copy.name)) copy.name = '(unregistered)';
    }
    if (copy.kind === 'request') {
      const label = (text: string) => redactOutput(text).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200) || '(unknown)';
      copy.provider = label(copy.provider); copy.modelId = label(copy.modelId);
    }
    this.emit(copy);
  }
}
