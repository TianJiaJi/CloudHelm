import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { inputProjection, omitUnapprovedInputs } from '../../packages/adapters/src/pi-input-projection.js';
import { queuedInputType } from '../../packages/adapters/src/pi-input-queue.js';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

it('measures offline, appends an omission once, and never erases the original receipt', () => {
  const manager = SessionManager.inMemory();
  const denied = manager.appendCustomMessageEntry(queuedInputType, 'UNDELIVERED_BODY', true, { id: 'failed' });
  manager.appendCustomMessageEntry(queuedInputType, 'DELIVERED_BODY', true, { id: 'delivered' });
  const allowed = (id: string) => id === 'delivered';
  const before = manager.getEntries();
  expect(JSON.stringify(inputProjection(manager, allowed))).not.toContain('UNDELIVERED_BODY');
  expect(manager.getEntries()).toEqual(before);
  omitUnapprovedInputs(manager, allowed); omitUnapprovedInputs(manager, allowed);
  expect(manager.getEntries().filter((entry) => entry.type === 'context_edit')).toEqual([
    expect.objectContaining({ type: 'context_edit', targetId: denied, replacement: null })]);
  expect(JSON.stringify(manager.getEntries())).toContain('UNDELIVERED_BODY');
  expect(JSON.stringify(inputProjection(manager, allowed))).toContain('DELIVERED_BODY');
});

it('fails closed for an existing summary of an unapproved input rather than pretending to sanitize it', () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomMessageEntry(queuedInputType, 'UNDELIVERED_BODY', true, { id: 'failed' });
  const kept = manager.appendMessage({ role: 'user', content: 'recent', timestamp: 2 });
  manager.appendCompaction('A summary possibly derived from the failed input', kept, 100);
  const before = manager.getEntries();
  expect(() => inputProjection(manager, () => false)).toThrow('旧摘要');
  expect(() => omitUnapprovedInputs(manager, () => false)).toThrow('旧摘要');
  expect(manager.getEntries()).toEqual(before);
});

it.each(['automatic', 'idle'] as const)('excludes failed queue content from real %s compaction, with auxiliary reservations and raw history intact', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-input-projection-'));
  const manager = SessionManager.create(root, root, { id: 'input-projection' });
  manager.appendMessage({ role: 'user', content: 'Original permitted intent', timestamp: 1 });
  manager.appendCustomMessageEntry(queuedInputType, 'UNDELIVERED_INPUT_MARKER '.repeat(100), true, { id: 'failed' });
  const assistant = (text: string, timestamp: number) => manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text }],
    api: 'openai-completions', provider: 'cloudhelm-custom', model: 'fixture', timestamp, stopReason: 'stop',
    usage: { input: 27000, output: 100, totalTokens: 27100, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  assistant('Permitted historical observation. '.repeat(5000), 2);
  manager.appendMessage({ role: 'user', content: 'Recent permitted intent', timestamp: 3 }); assistant('Recent observation', 4);
  const provider = await openAiFixture(async () => ({ text: 'Only permitted observations; unresolved effects remain unresolved.' }));
  const purposes: string[] = [];
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: provider.baseUrl },
    storage: { directory: root, id: 'input-projection', restore: true }, systemPrompt: 'Synthetic queue compaction.', tools: [],
    inputHistoryAllowed: () => false, clarification: { ask: async () => [] }, assertActive() {},
    beforeRequest: (purpose) => { purposes.push(purpose); }, event() {} });
  try {
    const file = manager.getSessionFile()!, before = await readFile(file, 'utf8');
    session.contextSnapshot!(); expect(await readFile(file, 'utf8')).toBe(before); expect(provider.requests).toHaveLength(0);
    if (mode === 'automatic') await session.prompt('Continue explicitly');
    else await session.compactIdle!({ signal: new AbortController().signal, assertValid() {}, reserve: (_profile, attempt) => { purposes.push(attempt.purpose); } });
    expect(purposes).toContain('compaction'); expect(provider.requests.length).toBe(purposes.length);
    if (mode === 'idle') expect(purposes.every((purpose) => purpose === 'compaction')).toBe(true);
    else expect(purposes.at(-1)).toBe('conversation');
    expect(JSON.stringify(provider.requests)).not.toContain('UNDELIVERED_INPUT_MARKER');
    const after = await readFile(file, 'utf8');
    expect(after.startsWith(before)).toBe(true); expect(after).toContain('UNDELIVERED_INPUT_MARKER');
    expect(after).toContain('"type":"context_edit"'); expect(after).toContain('"type":"compaction"');
  } finally { session.dispose(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});
