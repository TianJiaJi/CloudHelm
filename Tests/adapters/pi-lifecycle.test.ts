import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLifecycleObservation, ModelRequestAttempt } from '@cloudhelm/core';
import { withToolOrigin } from '../../packages/adapters/src/pi-tool-origin.js';
import { PiLifecycle } from '../../packages/adapters/src/pi-lifecycle.js';

afterEach(() => vi.useRealTimers());
it('publishes bounded metadata, stable parent identities and duration, never raw progress payloads', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const events: AgentLifecycleObservation[] = [], lifecycle = new PiLifecycle((value) => events.push(value), new Set(['codemode', 'query']));
  const root = { code: 'PRIVATE_SCRIPT' }, args = { secret: 'PRIVATE_ARGUMENT' };
  lifecycle.observe({ type: 'agent_start' });
  lifecycle.observe({ type: 'tool_execution_start', toolCallId: 'PRIVATE_ID', toolName: 'codemode', args: root });
  const origin = lifecycle.originFor('PRIVATE_ID')!;
  withToolOrigin(origin, () => lifecycle.observe({ type: 'tool_execution_start', toolCallId: 'child', parentToolCallId: 'PRIVATE_ID', toolName: 'query', args }));
  vi.setSystemTime(1200);
  withToolOrigin(origin, () => lifecycle.observe({ type: 'tool_execution_update', toolCallId: 'child', parentToolCallId: 'PRIVATE_ID', toolName: 'query', args,
    partialResult: { content: [{ type: 'text', text: 'PRIVATE_PROGRESS' }], details: { credential: 'PRIVATE_DETAIL' } } }));
  withToolOrigin(origin, () => lifecycle.observe({ type: 'tool_execution_end', toolCallId: 'child', parentToolCallId: 'PRIVATE_ID', toolName: 'query',
    result: { content: [], details: { password: 'PRIVATE_RESULT' } }, isError: false, durationMs: 200 }));
  const tools = events.filter((value) => value.kind === 'tool');
  expect(tools.at(-1)).toMatchObject({ name: 'query', status: 'complete', durationMs: 200, updates: 1, parentCallId: tools[0]!.callId });
  expect(tools.at(-1)!.parentToolCallId).toBe(tools[0]!.nativeId);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  lifecycle.close(); expect(events.at(-1)).toMatchObject({ kind: 'tool', name: 'codemode', status: 'interrupted' });
  expect(events.some((value) => value.kind === 'run' && value.status === 'settled')).toBe(false);
});

it('does not let late results for reused native IDs finish a newer run', () => {
  const events: AgentLifecycleObservation[] = [], lifecycle = new PiLifecycle((value) => events.push(value), new Set(['query']));
  const start = () => {
    lifecycle.observe({ type: 'agent_start' });
    lifecycle.observe({ type: 'tool_execution_start', toolCallId: 'parent', toolName: 'query', args: {} });
    const origin = lifecycle.originFor('parent')!;
    withToolOrigin(origin, () => lifecycle.observe({ type: 'tool_execution_start', toolCallId: 'same', parentToolCallId: 'parent', toolName: 'query', args: {} }));
    return origin;
  };
  const old = start(); lifecycle.observe({ type: 'agent_settled', aborted: true }); const current = start();
  const before = events.length;
  const end = () => lifecycle.observe({ type: 'tool_execution_end', toolCallId: 'same', parentToolCallId: 'parent', toolName: 'query', result: { content: [], details: {} }, isError: false });
  withToolOrigin(old, end);
  expect(events).toHaveLength(before); expect(events.at(-1)).toMatchObject({ kind: 'tool', status: 'running' });
  withToolOrigin(current, end);
  expect(events.at(-1)).toMatchObject({ kind: 'tool', status: 'complete' });
});

it('distinguishes provider token counts, catalog estimates, unknown custom prices and missing outcomes', () => {
  const events: AgentLifecycleObservation[] = [], lifecycle = new PiLifecycle((value) => events.push(value), new Set());
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'PRIVATE_KEY' };
  const attempt: ModelRequestAttempt = { logicalRequestId: 'request', attempt: 1, purpose: 'compaction', transport: 'http' };
  const message = { role: 'assistant' as const, api: 'openai-completions' as const, provider: profile.provider, model: profile.modelId,
    content: [{ type: 'text' as const, text: 'PRIVATE_BODY' }], timestamp: 1, stopReason: 'stop' as const,
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  lifecycle.requestStarted(attempt, profile); lifecycle.requestFinished(attempt, message);
  expect(events.at(-1)).toMatchObject({ kind: 'request', purpose: 'compaction', status: 'complete',
    tokens: { input: 10, output: 2, cacheRead: 3, source: 'provider' }, cost: { source: 'unknown', usd: null } });
  const next = { ...attempt, attempt: 2 };
  lifecycle.requestStarted(next, profile); lifecycle.requestFinished(next, { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: 0.25 } } }, true);
  expect(events.at(-1)).toMatchObject({ cost: { source: 'estimate', usd: 0.25 } });
  lifecycle.requestStarted({ ...attempt, attempt: 3 }, profile); lifecycle.close();
  expect(events.at(-1)).toMatchObject({ status: 'unknown', cost: { source: 'unknown', usd: null } });
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
