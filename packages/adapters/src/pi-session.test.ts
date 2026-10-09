import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { SessionEvent, SessionOptions } from '@cloudhelm/core';
import { createConversationSession } from './pi-session.js';
import { openAiFixture, type FixtureResponse } from './pi-session-fixture.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(reply: Parameters<typeof openAiFixture>[0], overrides: Partial<SessionOptions> = {}) {
  const fixture = await openAiFixture(reply);
  cleanup.push(fixture.close);
  const events: SessionEvent[] = [];
  const requests: string[] = [];
  const options: SessionOptions = { profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'key-only-in-memory', baseUrl: fixture.baseUrl },
    systemPrompt: 'You are the isolated test assistant.', tools: [],
    clarification: { ask: async () => [{ id: 'q', value: 'approved choice', custom: true }] },
    assertActive() {}, beforeRequest: (purpose) => { requests.push(purpose); }, event: (event) => { events.push(structuredClone(event)); }, ...overrides };
  const session = await createConversationSession(options);
  cleanup.push(() => session.dispose());
  return { session, fixture, events, requests, options };
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-native-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const usage = { prompt_tokens: 440, completion_tokens: 20, total_tokens: 460, prompt_tokens_details: { cached_tokens: 300 } };
const lastUsage = (events: SessionEvent[]) => events.filter((event) => event.type === 'usage').at(-1)?.value;

describe('native Pi session compatibility', () => {
  it('persists full tool/model metadata, projects stable IDs, and restores without requests or tool replay', async () => {
    const root = await directory();
    let calls = 0;
    const execute = vi.fn(async () => {
      const file = (await readdir(root)).find((name) => name.endsWith('.jsonl'))!;
      // Tool execution cannot precede persistence of its assistant call.
      expect(await readFile(join(root, file), 'utf8')).toContain('native-call');
      return { content: [{ type: 'text' as const, text: 'observed result' }], details: undefined };
    });
    const f = await setup(async () => ++calls === 1 ? { calls: [{ id: 'native-call', name: 'observe', arguments: {} }] }
      : { text: 'complete', usage }, { storage: { directory: root, id: 'bound-session', restore: false },
      tools: [{ name: 'observe', label: 'Observe', description: 'Observe once', parameters: Type.Object({}), replay: 'never', execute }] });
    await f.session.prompt('first user intent');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.fixture.requests[0]?.tools?.map((tool) => tool.function.name).sort()).toEqual(['ask_user', 'observe']);
    const projected = f.events.filter((event) => event.type === 'text').map((event) => event.value);
    expect(projected.map((message) => message.role)).toEqual(['user', 'agent']);
    expect(projected.every((message) => !!message.entryId)).toBe(true);
    const path = join(root, (await readdir(root)).find((name) => name.endsWith('.jsonl'))!);
    const transcript = await readFile(path, 'utf8');
    expect(transcript).toContain('toolResult');
    expect(transcript).toContain('model_change');
    expect(transcript).not.toContain('key-only-in-memory');
    f.session.dispose();
    const restoredEvents: SessionEvent[] = [];
    const restored = await createConversationSession({ ...f.options, storage: { directory: root, id: 'bound-session', restore: true }, event: (event) => restoredEvents.push(event) });
    cleanup.push(() => restored.dispose());
    expect(calls).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restoredEvents.filter((event) => event.type === 'text').map((event) => event.value)).toEqual(projected);
    expect(lastUsage(restoredEvents)).toBeUndefined();
    await restored.context('Authoritative recovery: verify unknown effects before any replay.');
    await restored.prompt('explicit continuation');
    expect(calls).toBe(3);
    expect(JSON.stringify(f.fixture.requests[2]?.messages)).toContain('observed result');
    expect(JSON.stringify(f.fixture.requests[2]?.messages)).toContain('Authoritative recovery');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed for missing, corrupt or mismatched transcript bindings', async () => {
    const root = await directory();
    const f = await setup(async () => ({ text: 'ok' }), { storage: { directory: root, id: 'bound-session', restore: false } });
    await f.session.prompt('hello');
    const path = join(root, (await readdir(root))[0]!);
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}{truncated\n`);
    await expect(createConversationSession({ ...f.options, storage: { directory: root, id: 'bound-session', restore: true } })).rejects.toThrow();
    const lines = original.trimEnd().split('\n').map((line) => JSON.parse(line));
    const message = lines.find((entry) => entry.type === 'message');
    message.message.content = null;
    await writeFile(path, lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await expect(createConversationSession({ ...f.options, storage: { directory: root, id: 'bound-session', restore: true } })).rejects.toThrow('损坏');
    await writeFile(path, original);
    await expect(createConversationSession({ ...f.options, storage: { directory: root, id: 'other-session', restore: true } })).rejects.toThrow('绑定');
    await rm(path);
    await expect(createConversationSession({ ...f.options, storage: { directory: root, id: 'bound-session', restore: true } })).rejects.toThrow('缺失');
    expect(f.fixture.requests).toHaveLength(1);
  });

  it('uses SDK usage without double-counting cached tokens and estimates new pending input', async () => {
    const f = await setup(async () => ({ text: 'ok', usage }));
    await f.session.prompt('hello');
    expect(lastUsage(f.events)).toMatchObject({ usedTokens: 460, source: 'provider', contextWindow: 32000 });
    await f.session.prompt('a'.repeat(400));
    const estimates = f.events.flatMap((event) => event.type === 'usage' && event.value.source === 'estimate' ? [event.value.usedTokens!] : []);
    expect(estimates.some((tokens) => tokens > 460 && tokens < 1000)).toBe(true);
    expect(lastUsage(f.events)?.usedTokens).toBe(460);
  });

  it('applies selection only at the next boundary and invalidates in-flight usage', async () => {
    let release!: (value: FixtureResponse) => void;
    const pending = new Promise<FixtureResponse>((resolve) => { release = resolve; });
    let calls = 0;
    const f = await setup(async () => ++calls === 1 ? pending : { text: 'new model', usage });
    const run = f.session.prompt('first');
    await vi.waitFor(() => expect(calls).toBe(1));
    f.session.select({ ...f.options.profile, modelId: 'second', apiKey: 'second-key' });
    expect(f.session.profile.modelId).toBe('fixture');
    expect(lastUsage(f.events)).toMatchObject({ model: { modelId: 'second' }, usedTokens: null });
    release({ calls: [{ id: 'ask', name: 'ask_user', arguments: { questions: [{ id: 'q', prompt: 'which?' }] } }], usage });
    await run;
    expect(f.fixture.requests.map((request) => request.model)).toEqual(['fixture', 'second']);
    expect(f.fixture.requests.map((request) => request.authorization)).toEqual(['Bearer key-only-in-memory', 'Bearer second-key']);
    expect(lastUsage(f.events)).toMatchObject({ model: { modelId: 'second' }, usedTokens: 460 });
  });

  it('keeps old-model usage invalid after restoring with a different selection', async () => {
    const root = await directory();
    const f = await setup(async () => ({ text: 'ok', usage }), { storage: { directory: root, id: 'bound-session', restore: false } });
    await f.session.prompt('hello');
    f.session.dispose();
    const events: SessionEvent[] = [];
    const restored = await createConversationSession({ ...f.options,
      profile: { ...f.options.profile, modelId: 'new-model' },
      storage: { directory: root, id: 'bound-session', restore: true }, event: (event) => events.push(event) });
    cleanup.push(() => restored.dispose());
    await restored.prompt('new model request');
    const readings = events.filter((event) => event.type === 'usage').map((event) => event.value);
    expect(readings[0]).toMatchObject({ usedTokens: null, model: { modelId: 'new-model' } });
    expect(readings.at(-1)).toMatchObject({ usedTokens: 460, model: { modelId: 'new-model' } });
  });

  it('never retries a context overflow response', async () => {
    const f = await setup(async () => ({ error: 'maximum context length exceeded', status: 400 }));
    await expect(f.session.prompt('hello')).rejects.toThrow();
    expect(f.fixture.requests).toHaveLength(1);
    expect(f.requests).toEqual(['conversation']);
  });

  it.each([429, 500])('never retries provider HTTP %s', async (status) => {
    const f = await setup(async () => ({ error: 'fixture failure', status }));
    await expect(f.session.prompt('hello')).rejects.toThrow();
    expect(f.fixture.requests).toHaveLength(1);
    expect(lastUsage(f.events)?.source).not.toBe('provider');
  });

  it('rejects missing credentials before sending a request even with ambient environment credentials', async () => {
    const key = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-key-must-not-be-used';
    try {
      await expect(createConversationSession({ profile: { provider: 'openai', modelId: 'gpt-4o', apiKey: '' },
        systemPrompt: '', tools: [], clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {} })).rejects.toThrow('Key');
    } finally { if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; }
  });
});
