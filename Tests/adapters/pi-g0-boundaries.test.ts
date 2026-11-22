import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { BusinessTool, SessionOptions } from '@cloudhelm/core';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { isolatedModelRuntime, resolveSessionModel } from '../../packages/adapters/src/pi-session-model.js';
import { fixtureMessageText, openAiFixture } from './pi-session-fixture.js';

// Opt in to a longer real-time wait without slowing the normal suite or changing global deadlines.
const holdMs = Number(process.env.CLOUDHELM_G0_HOLD_MS ?? 250);
if (!Number.isInteger(holdMs) || holdMs < 250 || holdMs > 120_000) throw new Error('G0 hold must be 250..120000 ms');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(execute: BusinessTool['execute']) {
  const fixture = await openAiFixture(async (request) => request.messages.some((message) => message.role === 'tool')
    ? { text: '已收到受控决定。' }
    : { calls: [{ id: 'g0-wait', name: 'wait_for_decision', arguments: {} }] });
  cleanup.push(fixture.close);
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'g0-synthetic-key', baseUrl: fixture.baseUrl };
  const options: SessionOptions = { profile, systemPrompt: 'G0 isolated loopback test.',
    tools: [{ name: 'wait_for_decision', label: 'Synthetic wait', description: 'Wait for a synthetic decision',
      parameters: Type.Object({}), replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {} };
  const session = await createConversationSession(options);
  cleanup.push(() => session.dispose());
  return { fixture, session };
}

it('G0-S01: a held tool consumes no second model request and completes on one explicit answer', async () => {
  const decision = deferred<string>();
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: await decision.promise }], details: undefined }));
  const f = await setup(execute);
  let settled = false;
  const run = f.session.prompt('等待人工决定');
  const finished = run.finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // Real wall-clock hold, not fake timers around SDK/network loading.
    // Even the opt-in minute probe does not prove hour-long operational reliability.
    await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
    expect(settled).toBe(false);
    expect(f.fixture.requests).toHaveLength(1);
    decision.resolve('approved-once');
    await finished;
    expect(f.fixture.requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.fixture.errors).toEqual([]);
    expect(f.fixture.requests[1]!.messages.filter((message) => message.role === 'tool').map(fixtureMessageText).join('\n')).toContain('approved-once');
  } finally { decision.resolve('cleanup'); await f.session.abort(); await finished.catch(() => {}); }
}, holdMs + 30_000);

it('G0-S02: abort reaches a waiting tool, and a late answer cannot restart the turn', async () => {
  const decision = deferred<string>();
  let received: AbortSignal | undefined;
  const execute = vi.fn(async (_id: string, _params: unknown, signal?: AbortSignal) => {
    received = signal;
    const answer = await Promise.race([decision.promise, new Promise<string>((resolve) => {
      if (signal?.aborted) resolve('cancelled');
      else signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
    })]);
    return { content: [{ type: 'text' as const, text: answer }], details: undefined };
  });
  const f = await setup(execute);
  const run = f.session.prompt('等待后停止');
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await f.session.abort(); await f.session.waitForIdle(); await run.catch(() => {});
    expect(received?.aborted).toBe(true);
    decision.resolve('late approval must not execute');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.fixture.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.session.lastTurnAnswered).toBe(false);
    expect(f.fixture.errors).toEqual([]);
  } finally { decision.resolve('cleanup'); await f.session.abort(); await run.catch(() => {}); }
});

it('G0-S03: the pinned SDK can disable builtin IO and ambient resources without losing prompting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-g0-sdk-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), agentDir = join(root, 'user');
  await mkdir(join(cwd, '.pi', 'skills', 'trap'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, 'AGENTS.md'), 'G0_CONTEXT_TRAP_MUST_NOT_BE_SENT');
  await writeFile(join(cwd, '.pi', 'skills', 'trap', 'SKILL.md'),
    '---\nname: trap\ndescription: G0_SKILL_TRAP_MUST_NOT_BE_SENT\n---\nG0_SKILL_BODY_MUST_NOT_BE_SENT');
  await writeFile(join(cwd, '.pi', 'extensions', 'trap.ts'), 'throw new Error("G0_AMBIENT_EXTENSION_MUST_NOT_RUN");');
  const fixture = await openAiFixture(async () => ({ text: 'isolated response' }));
  cleanup.push(fixture.close);
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'g0-synthetic-key', baseUrl: fixture.baseUrl };
  const settings = SettingsManager.inMemory({ packages: [], retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: 'off', compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Only the host-provided system prompt is permitted.' });
  await loader.reload();
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings,
    modelRuntime: await isolatedModelRuntime(profile), model: resolveSessionModel(profile).model,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: 'builtin', tools: [], customTools: [] });
  cleanup.push(() => session.dispose());
  expect(session.getActiveToolNames()).toEqual([]);
  await session.prompt('Reply without accessing external resources.');
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]!.tools ?? []).toEqual([]);
  const sent = JSON.stringify(fixture.requests[0]);
  expect(sent).not.toContain('G0_CONTEXT_TRAP');
  expect(sent).not.toContain('G0_SKILL_TRAP');
  expect(sent).not.toContain('G0_SKILL_BODY');
  expect(fixture.errors).toEqual([]);
});
