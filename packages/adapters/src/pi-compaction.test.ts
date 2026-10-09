import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionEvent, SessionProfile } from '@cloudhelm/core';
import { createConversationSession } from './pi-session.js';
import { openAiFixture, type FixtureResponse } from './pi-session-fixture.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(reply: Parameters<typeof openAiFixture>[0], before?: (purpose: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-compaction-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root, { id: 'native-compaction' });
  manager.appendMessage({ role: 'user', content: 'original user intent', timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Previous observation. '.repeat(5000) }],
    api: 'openai-completions', provider: 'cloudhelm-custom', model: 'fixture', timestamp: 2, stopReason: 'stop',
    usage: { input: 26000, output: 1000, totalTokens: 27000, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  manager.appendMessage({ role: 'user', content: 'recent intent', timestamp: 3 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'recent observation' }],
    api: 'openai-completions', provider: 'cloudhelm-custom', model: 'fixture', timestamp: 4, stopReason: 'stop',
    usage: { input: 27000, output: 100, totalTokens: 27100, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  const fixture = await openAiFixture(reply);
  cleanup.push(fixture.close);
  const events: SessionEvent[] = [];
  const requests: Array<{ purpose: string; profile: SessionProfile }> = [];
  let allowed = true;
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    storage: { directory: root, id: 'native-compaction', restore: true }, systemPrompt: 'CloudHelm fixture', tools: [],
    clarification: { ask: async () => [] }, assertActive: () => { if (!allowed) throw new Error('paused'); },
    beforeRequest: (purpose, profile) => { before?.(purpose); requests.push({ purpose, profile }); }, event: (event) => events.push(structuredClone(event)) });
  cleanup.push(() => session.dispose());
  return { session, fixture, events, requests, root, pause: async () => { allowed = false; await session.abort(); } };
}

describe('native semantic compaction', () => {
  it('uses a summary request, invalidates pre-compaction usage, and keeps the complete JSONL', async () => {
    let calls = 0;
    const f = await setup(async () => ++calls === 1 ? { text: '## Goal\nOriginal intent.\n## Progress\nObserved previous state; verify unresolved effects.' }
      : { text: 'continued', usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } });
    await f.session.prompt('continue explicitly');
    expect(f.fixture.errors).toEqual([]);
    expect(f.requests.map((request) => request.purpose)).toEqual(['compaction', 'conversation']);
    expect(f.events).toContainEqual({ type: 'compaction', status: 'complete', error: undefined });
    const usages = f.events.filter((event) => event.type === 'usage').map((event) => event.value);
    expect(usages.some((usage) => usage.usedTokens === null)).toBe(true);
    expect(usages.at(-1)).toMatchObject({ usedTokens: 520, source: 'provider' });
    const file = join(f.root, (await readdir(f.root)).find((name) => name.endsWith('.jsonl'))!);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('Previous observation.');
    expect(text).toContain('"type":"compaction"');
  });

  it('counts summary requests against the budget and fails without a conversation fallback', async () => {
    const f = await setup(async () => ({ text: 'never' }), (purpose) => { expect(purpose).toBe('compaction'); throw new Error('budget reached'); });
    await expect(f.session.prompt('continue')).rejects.toThrow('budget');
    expect(f.fixture.requests).toHaveLength(0);
    expect(f.events.some((event) => event.type === 'compaction' && event.status === 'failed')).toBe(true);
  });

  it('aborts compaction without generating a new conversation request', async () => {
    let release!: (response: FixtureResponse) => void;
    const pending = new Promise<FixtureResponse>((resolve) => { release = resolve; });
    const f = await setup(async () => pending);
    const run = f.session.prompt('continue');
    const failed = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(f.fixture.requests).toHaveLength(1), { timeout: 15_000 });
    expect(f.session.isStreaming).toBe(true);
    await expect(f.session.prompt('concurrent prompt')).rejects.toThrow('正在处理');
    let settled = false;
    const idle = f.session.waitForIdle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await f.pause();
    await idle;
    release({ text: 'late summary' });
    await failed;
    expect(f.requests.map((request) => request.purpose)).toEqual(['compaction']);
    expect(f.events.some((event) => event.type === 'compaction' && event.status === 'failed')).toBe(true);
  });

  it('uses the next selected model for compaction before the next prompt', async () => {
    let calls = 0;
    const f = await setup(async () => ++calls === 1 ? { text: 'summary' } : { text: 'done' });
    f.session.select({ ...f.session.profile, modelId: 'next-model', apiKey: 'next-key' });
    await f.session.prompt('continue');
    expect(f.requests[0]).toMatchObject({ purpose: 'compaction', profile: { modelId: 'next-model' } });
    expect(f.fixture.requests.every((request) => request.model === 'next-model' && request.authorization === 'Bearer next-key')).toBe(true);
  });
});
