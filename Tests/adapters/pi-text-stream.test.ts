import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEvent, SessionOptions } from '@cloudhelm/core';
import { PiTextStream } from '../../packages/adapters/src/pi-text-stream.js';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const message = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }],
  api: 'openai', provider: 'openai', model: 'test', timestamp: 1, thinkingLevel: 'off', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

it('coalesces streamed text updates, skips whitespace-only bodies and clears with a final null', () => {
  vi.useFakeTimers(); cleanup.push(() => { vi.useRealTimers(); });
  const emitted: Array<string | null> = [];
  const stream = new PiTextStream((value) => emitted.push(value ? value.text : null));
  stream.update(message('部分'));
  stream.update(message('部分答案'));
  expect(emitted).toEqual([]);
  vi.advanceTimersByTime(60);
  expect(emitted).toEqual(['部分答案']);
  stream.update(message('  '));
  vi.advanceTimersByTime(120);
  expect(emitted).toEqual(['部分答案']);
  stream.clear();
  stream.clear();
  expect(emitted).toEqual(['部分答案', null]);
  stream.update(message('完整答案'));
  stream.clear();
  stream.clear();
  expect(emitted).toEqual(['部分答案', null, '完整答案', null]);
});

it('assigns a fresh stable identity to each streamed message', () => {
  vi.useFakeTimers(); cleanup.push(() => { vi.useRealTimers(); });
  const ids: string[] = [];
  const stream = new PiTextStream((value) => { if (value) ids.push(value.id); });
  stream.update(message('one'));
  stream.update(message('one more'));
  vi.advanceTimersByTime(60);
  stream.clear();
  stream.update(message('two'));
  vi.advanceTimersByTime(60);
  stream.clear();
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

it('streams assistant body text progressively and finishes with the projected transcript and a null', async () => {
  const fixture = await openAiFixture(async () => ({ reasoning: ['先想一想。'], text: '检查完成。', textParts: ['检查', '完成。'] }));
  cleanup.push(fixture.close);
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-text-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const events: SessionEvent[] = [];
  const options: SessionOptions = { profile: { provider: 'deepseek', modelId: 'deepseek-v4-pro', baseUrl: fixture.baseUrl, apiKey: 'fixture' },
    thinkingLevel: 'high', storage: { directory: root, id: 'text-stream', restore: false }, systemPrompt: '', tools: [],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(structuredClone(event)) };
  const session = await createConversationSession(options); cleanup.push(() => session.dispose());
  await session.prompt('开始检查');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'text-progress' && event.value?.text === '检查完成。')).toBe(true), { timeout: 15_000 });
  expect(events.filter((event) => event.type === 'text' && event.value.role === 'agent').at(-1)).toMatchObject({ value: { text: '检查完成。' } });
  expect(events.filter((event) => event.type === 'text-progress').at(-1)).toEqual({ type: 'text-progress', value: null });
});
