import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ReasoningProgress, SessionEvent, SessionOptions, TextProgress } from '@cloudhelm/core';
import { PiTextStream } from '../../packages/adapters/src/pi-text-stream.js';
import { PiReasoningStream, reasoningView } from '../../packages/adapters/src/pi-reasoning.js';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** Deterministic PRNG so every "arbitrary" pattern in this file is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cumulative streamed prefixes; step 1..9 code units so surrogate pairs and CRLF can be split mid-boundary. */
function cumulativePrefixes(sample: string, seed: number): string[] {
  const random = mulberry32(seed);
  const prefixes: string[] = [];
  let end = 0;
  while (end < sample.length) {
    end = Math.min(end + 1 + Math.floor(random() * 9), sample.length);
    prefixes.push(sample.slice(0, end));
  }
  return prefixes;
}

const sample = '# 检查结果\r\n\r\n```bash\r\ndocker logs --tail 50 🚀\r\n```\r\n\r\n| 项 | 值 |\r\n| --- | --- |\r\n| 状态 | 正常 |\r\n\r\n结论：一切正常。\r\n';
const textMessage = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }],
  api: 'openai', provider: 'openai', model: 'test', timestamp: 1, thinkingLevel: 'off', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const thinkingMessage = (thinking: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'thinking', thinking }],
  api: 'openai-responses', provider: 'openai', model: 'test', timestamp: 1, thinkingLevel: 'high', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

it('keeps the latest body under seeded arbitrary update timing, boundary splits and whitespace-only bodies', () => {
  vi.useFakeTimers(); cleanup.push(() => { vi.useRealTimers(); });
  for (const seed of [3, 17, 64, 129, 2026]) {
    const random = mulberry32(seed * 7919);
    const emitted: Array<TextProgress | null> = [];
    const stream = new PiTextStream((value) => emitted.push(value));
    const inputs = [' \r\n', '\r\n', ...cumulativePrefixes(sample, seed)];
    for (const text of inputs) {
      stream.update(textMessage(text));
      vi.advanceTimersByTime(Math.floor(random() * 120));
    }
    stream.clear();
    const bodies = emitted.filter((value): value is TextProgress => value !== null);
    expect(emitted.at(-1)).toBeNull();
    expect(bodies.map((value) => value.text).at(-1)).toBe(sample);
    for (const value of bodies) {
      expect(value.text.trim()).not.toBe('');
      expect(sample.startsWith(value.text)).toBe(true);
    }
    for (let index = 1; index < bodies.length; index++) {
      expect(bodies[index]!.text.length).toBeGreaterThanOrEqual(bodies[index - 1]!.text.length);
    }
    const id = bodies[0]?.id;
    expect(bodies.every((value) => value.id === id)).toBe(true);
    emitted.length = 0;
    stream.update(textMessage('第二次回答'));
    stream.clear();
    const second = emitted.filter((value): value is TextProgress => value !== null);
    expect(second.map((value) => value.text)).toEqual(['第二次回答']);
    expect(second[0]!.id).not.toBe(id);
    expect(emitted.at(-1)).toBeNull();
  }
});

it('keeps the latest reasoning view under seeded arbitrary timing and flushes on clear', () => {
  vi.useFakeTimers(); cleanup.push(() => { vi.useRealTimers(); });
  const reasoningSample = '先检查服务状态。\r\n再核对退出码与日志。\r\n最后确认端口监听。';
  for (const seed of [5, 23, 101]) {
    const random = mulberry32(seed * 104729);
    const emitted: Array<ReasoningProgress | null> = [];
    const stream = new PiReasoningStream((value) => emitted.push(value));
    const inputs = cumulativePrefixes(reasoningSample, seed).map((thinking) => thinkingMessage(thinking));
    for (const input of inputs) {
      stream.update(input, true);
      vi.advanceTimersByTime(Math.floor(random() * 120));
    }
    stream.clear();
    const bodies = emitted.filter((value): value is ReasoningProgress => value !== null);
    expect(emitted.at(-1)).toBeNull();
    const expectedTexts = inputs.map((input) => reasoningView(input, true, true)?.text ?? '');
    expect(bodies.map((value) => value.reasoning.text).at(-1)).toBe(expectedTexts.at(-1));
    for (const value of bodies) {
      expect(expectedTexts).toContain(value.reasoning.text);
      expect(value.reasoning.status).toBe('streaming');
    }
    for (let index = 1; index < bodies.length; index++) {
      expect(bodies[index]!.reasoning.text.length).toBeGreaterThanOrEqual(bodies[index - 1]!.reasoning.text.length);
    }
    expect(bodies.every((value) => value.id === bodies[0]?.id)).toBe(true);
  }
});

it('reassembles seeded arbitrary SSE chunk splits byte-exactly through the real pipeline', async () => {
  const random = mulberry32(20261117);
  const parts: string[] = [];
  let start = 0;
  while (start < sample.length) {
    const end = Math.min(start + 1 + Math.floor(random() * 7), sample.length);
    parts.push(sample.slice(start, end));
    start = end;
  }
  expect(parts.join('')).toBe(sample);
  const fixture = await openAiFixture(async () => ({ reasoning: [], text: sample, textParts: parts }));
  cleanup.push(fixture.close);
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-chunking-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const events: SessionEvent[] = [];
  const options: SessionOptions = { profile: { provider: 'deepseek', modelId: 'deepseek-v4-pro', baseUrl: fixture.baseUrl, apiKey: 'fixture' },
    thinkingLevel: 'high', storage: { directory: root, id: 'chunking-arbitrary', restore: false }, systemPrompt: '', tools: [],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(structuredClone(event)) };
  const session = await createConversationSession(options); cleanup.push(() => session.dispose());
  await session.prompt('开始检查');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'text-progress' && event.value?.text === sample)).toBe(true), { timeout: 15_000 });
  // The transcript projection intentionally trims the persisted body; streamed emissions stay byte-exact.
  expect(events.filter((event) => event.type === 'text' && event.value.role === 'agent').at(-1)).toMatchObject({ value: { text: sample.trim() } });
  expect(events.filter((event) => event.type === 'text-progress').at(-1)).toEqual({ type: 'text-progress', value: null });
  for (const event of events) {
    if (event.type === 'text-progress' && event.value) expect(sample.startsWith(event.value.text)).toBe(true);
  }
});

it('survives adversarial splits across CRLF, surrogate pairs and fence boundaries', async () => {
  const rocket = '🚀';
  const text = '```bash\r\necho ' + rocket + ' done\r\n```\r\n';
  const parts = ['``', '`bash\r', '\necho ' + rocket.charAt(0), rocket.charAt(1) + ' don', 'e\r', '\n```', '\r', '\n'];
  expect(parts.join('')).toBe(text);
  const fixture = await openAiFixture(async () => ({ reasoning: [], text, textParts: parts }));
  cleanup.push(fixture.close);
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-chunking-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const events: SessionEvent[] = [];
  const options: SessionOptions = { profile: { provider: 'deepseek', modelId: 'deepseek-v4-pro', baseUrl: fixture.baseUrl, apiKey: 'fixture' },
    thinkingLevel: 'high', storage: { directory: root, id: 'chunking-adversarial', restore: false }, systemPrompt: '', tools: [],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(structuredClone(event)) };
  const session = await createConversationSession(options); cleanup.push(() => session.dispose());
  await session.prompt('开始检查');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'text-progress' && event.value?.text === text)).toBe(true), { timeout: 15_000 });
  expect(events.filter((event) => event.type === 'text' && event.value.role === 'agent').at(-1)).toMatchObject({ value: { text: text.trim() } });
  expect(events.filter((event) => event.type === 'text-progress').at(-1)).toEqual({ type: 'text-progress', value: null });
  for (const event of events) {
    if (event.type === 'text-progress' && event.value) expect(text.startsWith(event.value.text)).toBe(true);
  }
});
