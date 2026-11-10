import { afterEach, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { BusinessTool, ConversationSession, SessionEvent } from '@cloudhelm/core';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { fixtureMessageText, openAiFixture } from './pi-session-fixture.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(code: string, executeQuery?: (args: { value: number }, signal?: AbortSignal) => Promise<void>, followMutation = false) {
  let allowed = true, calls = 0;
  const events: SessionEvent[] = [];
  const query = vi.fn(async (_id: string, args: { value: number }, signal?: AbortSignal) => {
    await executeQuery?.(args, signal);
    return { content: [{ type: 'text' as const, text: 'query observation' }], details: { private: 'never expose this renderer detail' },
      structuredContent: { answer: args.value, observation: 'synthetic' } };
  });
  const mutate = vi.fn(async () => ({ content: [], details: undefined }));
  const tools: BusinessTool[] = [
    { name: 'query', label: 'Query', description: 'Authorized synthetic observation', access: 'query', deferred: true,
      available: () => allowed, replay: 'never', parameters: Type.Object({ value: Type.Integer() }, { additionalProperties: false }), execute: query },
    { name: 'mutate', label: 'Mutate', description: 'Forbidden to scripts', replay: 'never', parameters: Type.Object({}), execute: mutate }
  ];
  const provider = await openAiFixture(async () => ++calls === 1 ? { calls: [{ id: 'script', name: 'codemode', arguments: { code } }, ...(followMutation ? [{ id: 'after-script', name: 'mutate', arguments: {} }] : [])] } : { text: 'Explained the observations.' });
  cleanups.push(provider.close);
  const session: ConversationSession = await createConversationSession({ tools,
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic-only', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic query integration. No SSH or real model service.',
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(event) });
  cleanups.push(() => session.dispose());
  const output = () => provider.requests.slice(1).flatMap((request) => request.messages.filter((message) => message.role === 'tool')).map(fixtureMessageText).join('\n');
  return { session, provider, query, mutate, events, output, revoke: () => { allowed = false; } };
}
it('runs native QuickJS over authorized structured queries, with no models, shell, network or private details', async () => {
  const f = await fixture('const result = await tools.query({value: 9}); return {answer: result.data.answer, error: result.isError, models: typeof models, node: typeof process, network: typeof fetch, forbidden: "mutate" in tools, names: ALL_TOOLS.map(t => t.name)};');
  await f.session.prompt('Summarize the authorized observation');
  expect(f.query).toHaveBeenCalledOnce(); expect(f.mutate).not.toHaveBeenCalled();
  expect(f.provider.requests).toHaveLength(2);
  expect(f.output()).toMatch(/"answer"\s*:\s*9/u); expect(f.output()).toMatch(/"models"\s*:\s*"undefined"/u);
  expect(f.output()).toMatch(/"node"\s*:\s*"undefined"/u); expect(f.output()).toMatch(/"network"\s*:\s*"undefined"/u);
  expect(f.output()).toMatch(/"forbidden"\s*:\s*false/u); expect(f.output()).not.toContain('never expose');
  const observations = f.events.flatMap((event) => event.type === 'lifecycle' ? [event.value] : []);
  expect(observations).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'query', status: 'complete', parentCallId: expect.any(String) }));
  expect(observations).toContainEqual(expect.objectContaining({ kind: 'run', status: 'settled', aborted: false }));
  expect(observations).toContainEqual(expect.objectContaining({ kind: 'request', status: 'complete', cost: { source: 'unknown', usd: null } }));
  expect(f.events.filter((event) => event.type === 'tool-start' && event.name === 'query')).toHaveLength(1);
  expect(f.events.filter((event) => event.type === 'tool-end' && event.name === 'query')).toHaveLength(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool-start', name: 'query', parentToolCallId: 'script' }));
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool-end', name: 'query', parentToolCallId: 'script', isError: false }));
});
it.each(['await tools.mutate({});', 'await models.getAvailableOfType("classifier");',
  'await tools.query({value:"3"});', '// @options: {"timeout_ms":999999}\nreturn 1;',
  'store("page", {text:"not a reference"});'])('blocks sandbox escape, coercion or policy override: %s', async (code) => {
  const f = await fixture(code); await f.session.prompt('Try the synthetic policy boundary');
  expect(f.query).not.toHaveBeenCalled(); expect(f.mutate).not.toHaveBeenCalled();
  expect(f.provider.requests).toHaveLength(2);
  expect(f.output()).toMatch(/failed|Error|未执行|backend-owned|cache/u);
});
it('caps native nested dispatch at 32 calls and 4 concurrent queries with backend parent receipts', async () => {
  let release!: () => void, active = 0, peak = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture('const all = await Promise.allSettled(Array.from({length:40}, (_,value) => tools.query({value}))); return {ok:all.filter(x=>x.status==="fulfilled").length, denied:all.filter(x=>x.status==="rejected").length};', async () => {
    peak = Math.max(peak, ++active); await hold; active--;
  });
  const run = f.session.prompt('Aggregate bounded independent queries');
  try {
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(4)); release(); await run;
    expect(peak).toBe(4); expect(f.query).toHaveBeenCalledTimes(32); expect(f.mutate).not.toHaveBeenCalled();
    expect(f.output()).toMatch(/"ok"\s*:\s*32/u); expect(f.output()).toMatch(/"denied"\s*:\s*8/u);
  } finally { release(); await run; }
});
it('rechecks authorization for queued queries before dispatch and suppresses revoked results', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture('return await Promise.allSettled(Array.from({length:8}, (_,value) => tools.query({value})));', async () => { await hold; });
  const run = f.session.prompt('Exercise scope revocation');
  try {
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(4)); f.revoke(); release(); await run;
    expect(f.query).toHaveBeenCalledTimes(4); expect(f.mutate).not.toHaveBeenCalled();
    expect(f.output()).not.toContain('"observation"');
  } finally { release(); await run; }
});
it('keeps a model-issued mutation after the whole script, never alongside its parallel queries', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture('await Promise.all(Array.from({length:4}, (_,value) => tools.query({value})));', async () => { await hold; }, true);
  const run = f.session.prompt('Check the outer execution barrier');
  try {
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(4));
    expect(f.mutate).not.toHaveBeenCalled(); release(); await run;
    expect(f.mutate).toHaveBeenCalledOnce(); expect(f.provider.requests).toHaveLength(2);
  } finally { release(); await run; }
});
it('enforces a real VM deadline for an infinite script without changing the test timeout', async () => {
  const f = await fixture('while (true) {}'); await f.session.prompt('Exercise the fixed sandbox deadline');
  expect(f.output()).toMatch(/deadline|timed out|aborted/iu);
  expect(f.query).not.toHaveBeenCalled(); expect(f.provider.requests).toHaveLength(2);
});
