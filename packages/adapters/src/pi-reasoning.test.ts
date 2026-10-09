import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEvent, SessionOptions } from '@cloudhelm/core';
import { reasoningView } from './pi-reasoning.js';
import { createConversationSession } from './pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const message = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: 'assistant', content: [],
  api: 'openai-responses', provider: 'openai', model: 'test', timestamp: 1, thinkingLevel: 'high', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
it('projects visible summaries without signatures or redacted payloads and distinguishes no content from disabled reasoning', () => {
  const value = reasoningView(message({ content: [{ type: 'thinking', thinking: '接口提供的摘要', thinkingSignature: 'opaque-signature' },
    { type: 'thinking', thinking: 'must-not-display', thinkingSignature: 'opaque-encrypted', redacted: true }] }));
  expect(value).toMatchObject({ kind: 'summary', text: '接口提供的摘要', status: 'complete', redacted: true });
  expect(JSON.stringify(value)).not.toMatch(/opaque|must-not-display/u);
  expect(reasoningView(message())).toMatchObject({ status: 'unavailable', text: '' });
  expect(reasoningView(message({ thinkingLevel: 'off' }))).toBeUndefined();
  expect(reasoningView(message({ content: [{ type: 'thinking', thinking: 'api_key=synthetic-secret' }] }))?.text).not.toContain('synthetic-secret');
});
it.each([false, true])('streams actual returned thinking, retains final/interrupted content and restores natively (stop=%s)', async (stop) => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  cleanup.push(release);
  const fixture = await openAiFixture(async () => ({ reasoning: ['先检查服务状态。', '\n再核对退出码。'], afterReasoning: () => barrier, text: '检查完成。' }));
  cleanup.push(fixture.close);
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-reasoning-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const events: SessionEvent[] = [];
  const options: SessionOptions = { profile: { provider: 'deepseek', modelId: 'deepseek-v4-pro', baseUrl: fixture.baseUrl, apiKey: 'fixture' },
    thinkingLevel: 'high', storage: { directory: root, id: 'reasoning', restore: false }, systemPrompt: '', tools: [],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(structuredClone(event)) };
  const session = await createConversationSession(options); cleanup.push(() => session.dispose());
  const running = session.prompt('开始检查');
  const outcome = running.catch((error: unknown) => error);
  await vi.waitFor(() => expect(events.filter((event) => event.type === 'reasoning-progress' && event.value?.reasoning.text.includes('退出码'))).toHaveLength(1));
  expect(events.some((event) => event.type === 'text' && event.value.role === 'agent')).toBe(false);
  if (stop) await session.abort(); else release();
  await outcome;
  release();
  const projected = events.filter((event) => event.type === 'text' && event.value.role === 'agent').at(-1);
  expect(projected).toMatchObject({ value: { reasoning: { text: '先检查服务状态。\n再核对退出码。', status: stop ? 'interrupted' : 'complete' } } });
  expect(events.filter((event) => event.type === 'reasoning-progress').at(-1)).toEqual({ type: 'reasoning-progress', value: null });
  session.dispose();
  const restoredEvents: SessionEvent[] = [];
  const restored = await createConversationSession({ ...options, thinkingLevel: undefined, storage: { directory: root, id: 'reasoning', restore: true }, event: (event) => restoredEvents.push(event) });
  cleanup.push(() => restored.dispose());
  expect(restoredEvents.filter((event) => event.type === 'text' && event.value.role === 'agent').at(-1)).toEqual(projected);
  expect(fixture.requests).toHaveLength(1);
});
