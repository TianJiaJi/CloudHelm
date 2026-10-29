import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { RequestBudgetError, type BusinessTool, type IdleCompactionLease } from '@cloudhelm/core';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture, type FixtureResponse } from './pi-session-fixture.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(reply: Parameters<typeof openAiFixture>[0], tools: BusinessTool[] = [], history: boolean | 'single-large' = true) {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-idle-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (history) {
    const manager = SessionManager.create(root, root, { id: 'idle-fixture' });
    manager.appendMessage({ role: 'user', content: 'original intent', timestamp: 1 });
    const assistant = (text: string, timestamp: number) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }],
      api: 'openai-completions' as const, provider: 'cloudhelm-custom', model: 'fixture', timestamp, stopReason: 'stop' as const,
      usage: { input: 27000, output: 100, totalTokens: 27100, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
    if (history === 'single-large') manager.appendMessage(assistant('Old observation. '.repeat(5000), 2));
    else for (let index = 0; index < 20; index++) {
      manager.appendMessage({ role: 'user', content: `Prior selection ${index}: ${'Bounded selected text. '.repeat(200)}`, timestamp: 2 });
      manager.appendMessage(assistant('Old observation.', 2));
    }
    manager.appendMessage({ role: 'user', content: 'recent intent', timestamp: 3 });
    manager.appendMessage(assistant('recent observation', 4));
  }
  const fixture = await openAiFixture(reply); cleanups.push(fixture.close);
  const ordinary = vi.fn(); let allowed = !history; let generation = 'one';
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', baseUrl: fixture.baseUrl, apiKey: 'dummy' },
    storage: { directory: root, id: 'idle-fixture', restore: !!history }, systemPrompt: 'Fixture only', tools,
    clarification: { ask: async () => [] }, assertActive: () => { if (!allowed) throw new Error('normal task is paused'); },
    requestGeneration: () => generation, beforeRequest: ordinary, event() {} });
  cleanups.push(() => session.dispose());
  const controller = new AbortController(); const reserve = vi.fn(async () => {});
  const lease: IdleCompactionLease = { signal: controller.signal, assertValid() {}, reserve };
  return { root, fixture, session, lease, reserve, ordinary, controller, enable: () => { allowed = true; }, change: () => { generation = 'two'; },
    transcript: async () => readFile(join(root, (await readdir(root)).find((name) => name.endsWith('.jsonl'))!), 'utf8') };
}
it('compacts a paused session through a separate metered lease without prompting, tools or losing JSONL history', async () => {
  const f = await setup(async () => ({ text: '## Goal\nOriginal intent.\n## Progress\nOld observations retained as references.' }));
  const before = f.session.contextSnapshot!(); const original = await f.transcript();
  await f.session.compactIdle!(f.lease);
  expect(f.ordinary).not.toHaveBeenCalled(); expect(f.reserve).toHaveBeenCalledOnce();
  expect(f.reserve.mock.calls[0]).toEqual([expect.objectContaining({ modelId: 'fixture' }), expect.objectContaining({ purpose: 'compaction', attempt: 1 }), expect.any(AbortSignal)]);
  expect(f.fixture.requests).toHaveLength(1); expect(f.fixture.requests[0]?.tools ?? []).toHaveLength(0);
  expect(f.session.isStreaming).toBe(false);
  const after = f.session.contextSnapshot!(); expect(after.revision).not.toBe(before.revision);
  expect(after.budget.usedTokens).toBeLessThan(before.budget.usedTokens);
  const transcript = await f.transcript(); expect(transcript.startsWith(original)).toBe(true);
  expect(transcript).toContain('Old observation.'); expect(transcript).toContain('"type":"compaction"');
});
it('invalidates prepared versions across model round trips and allows non-mutating frame previews', async () => {
  const f = await setup(async () => ({ text: 'unused' }));
  const before = f.session.contextSnapshot!();
  const preview = f.session.contextSnapshot!('Prospective authorization frame. '.repeat(1000));
  expect(preview.budget.usedTokens).toBeGreaterThan(before.budget.usedTokens);
  expect(f.session.contextSnapshot!().revision).toBe(before.revision);
  const original = f.session.profile;
  f.session.select({ ...original, modelId: 'other' }); f.session.select(original);
  expect(f.session.contextSnapshot!().revision).not.toBe(before.revision);
  expect(f.fixture.requests).toHaveLength(0);
});
it('does not manufacture input space when the native kept boundary retains one oversized message', async () => {
  const f = await setup(async () => ({ text: 'brief prefix summary' }), [], 'single-large');
  const before = f.session.contextSnapshot!();
  await f.session.compactIdle!(f.lease);
  const after = f.session.contextSnapshot!();
  expect(after.revision).not.toBe(before.revision);
  expect(after.budget.availableInput).toBe(0);
  expect(after.historyTokens).toBeGreaterThan(40000);
  expect(f.reserve).toHaveBeenCalledOnce(); expect(f.fixture.requests).toHaveLength(1);
  expect(f.ordinary).not.toHaveBeenCalled();
  expect(await f.transcript()).toContain('Old observation.');
});
it('preserves the exact budget refusal, sends zero HTTP requests and leaves history unchanged', async () => {
  const f = await setup(async () => ({ text: 'never' })); const original = await f.transcript();
  const refusal = new RequestBudgetError('budget-exhausted'); f.reserve.mockRejectedValue(refusal);
  await expect(f.session.compactIdle!(f.lease)).rejects.toBe(refusal);
  expect(f.fixture.requests).toHaveLength(0); expect(f.ordinary).not.toHaveBeenCalled();
  expect(await f.transcript()).toBe(original);
});
it.each(['cancel', 'model', 'thinking', 'policy', 'steer', 'context'] as const)('rejects %s invalidation while a compaction reservation is awaiting acknowledgment', async (kind) => {
  const f = await setup(async () => ({ text: 'never' }));
  if (kind === 'thinking') f.session.select({ ...f.session.profile, provider: 'deepseek', modelId: 'deepseek-v4-pro' });
  const original = await f.transcript();
  let acknowledge!: () => void; f.reserve.mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const run = f.session.compactIdle!(f.lease); const rejected = expect(run).rejects.toThrow();
  await vi.waitFor(() => expect(f.reserve).toHaveBeenCalledOnce());
  await expect(f.session.prompt('concurrent input')).rejects.toThrow('正在处理');
  await expect(f.session.compactIdle!(f.lease)).rejects.toThrow('尚未空闲');
  if (kind === 'cancel') f.controller.abort();
  if (kind === 'model') f.session.select({ ...f.session.profile, modelId: 'new-model' });
  if (kind === 'thinking') f.session.setThinking('high');
  if (kind === 'policy') f.change();
  if (kind === 'steer') await expect(f.session.steer('new instruction')).rejects.toThrow('未投递');
  if (kind === 'context') await expect(f.session.context('changed facts')).rejects.toThrow('上下文发生变化');
  acknowledge(); await rejected; await f.session.waitForIdle();
  expect(f.fixture.requests).toHaveLength(0); expect(f.ordinary).not.toHaveBeenCalled();
  const transcript = await f.transcript(); expect(transcript.startsWith(original)).toBe(true);
  expect(transcript).not.toContain('"type":"compaction"'); expect(transcript).not.toContain('new instruction');
});
it('stops an in-flight native summary without a conversation fallback or late compaction entry', async () => {
  let release!: (value: FixtureResponse) => void;
  const response = new Promise<FixtureResponse>((resolve) => { release = resolve; });
  const f = await setup(async () => response); const original = await f.transcript();
  const run = f.session.compactIdle!(f.lease); const rejected = expect(run).rejects.toThrow();
  await vi.waitFor(() => expect(f.fixture.requests).toHaveLength(1));
  try { await f.session.abort(); await rejected; await f.session.waitForIdle(); }
  finally { release({ text: 'late summary' }); }
  expect(f.fixture.requests).toHaveLength(1); expect(f.reserve).toHaveBeenCalledOnce();
  expect(f.ordinary).not.toHaveBeenCalled(); expect(await f.transcript()).toBe(original);
});
it('does not abort an active tool to make room for manual compaction', async () => {
  let finish!: () => void; let toolSignal: AbortSignal | undefined;
  const execute = vi.fn(async (_id: string, _args: never, signal?: AbortSignal) => {
    toolSignal = signal; await new Promise<void>((resolve) => { finish = resolve; });
    return { content: [{ type: 'text' as const, text: 'observed' }], details: undefined };
  });
  let requests = 0;
  const f = await setup(async (): Promise<FixtureResponse> => ++requests === 1
    ? { calls: [{ id: 'observe', name: 'observe', arguments: {} }] } : { text: 'done' },
  [{ name: 'observe', label: 'observe', description: 'Fixture observation', replay: 'never', parameters: { type: 'object', properties: {} }, execute }], false);
  const run = f.session.prompt('observe once');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  try {
    await expect(f.session.compactIdle!(f.lease)).rejects.toThrow('尚未空闲');
    expect(toolSignal?.aborted).toBe(false); expect(f.reserve).not.toHaveBeenCalled();
  } finally { finish(); }
  await run; expect(execute).toHaveBeenCalledOnce(); expect(f.fixture.requests).toHaveLength(2);
});
