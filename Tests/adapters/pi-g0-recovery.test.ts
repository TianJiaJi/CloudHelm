import { copyFile, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { SessionOptions } from '@cloudhelm/core';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

it('G0-S04: restoring a transcript captured during a tool wait performs no request or tool replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-g0-recovery-'));
  const original = join(root, 'original'), snapshot = join(root, 'snapshot');
  await mkdir(original); await mkdir(snapshot);
  let release = (_value: string) => {};
  const held = new Promise<string>((resolve) => { release = resolve; });
  const execute = vi.fn(async (_id: string, _params: unknown, signal?: AbortSignal) => {
    if (signal?.aborted) release('cancelled');
    else signal?.addEventListener('abort', () => release('cancelled'), { once: true });
    return { content: [{ type: 'text' as const, text: await held }], details: undefined };
  });
  const fixture = await openAiFixture(async () => ({ calls: [{ id: 'pending-g0-tool', name: 'wait_for_decision', arguments: {} }] }));
  const options: SessionOptions = { profile: { provider: 'cloudhelm-custom', modelId: 'fixture',
    apiKey: 'g0-synthetic-key', baseUrl: fixture.baseUrl }, systemPrompt: 'Isolated G0 recovery test.',
    tools: [{ name: 'wait_for_decision', label: 'Wait', description: 'Synthetic pending decision',
      parameters: Type.Object({}), replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {},
    storage: { directory: original, id: 'g0-pending-session', restore: false } };
  let session: Awaited<ReturnType<typeof createConversationSession>> | undefined;
  let restored: Awaited<ReturnType<typeof createConversationSession>> | undefined;
  let run: Promise<void> | undefined;
  try {
    session = await createConversationSession(options);
    run = session.prompt('Hold a decision');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const transcripts = (await readdir(original)).filter((name) => name.endsWith('.jsonl'));
    expect(transcripts).toHaveLength(1);
    const name = transcripts[0]!;
    const before = await readFile(join(original, name), 'utf8');
    expect(before).toContain('pending-g0-tool');
    expect(before).not.toContain('"role":"toolResult"');
    // Snapshot only the durable transcript before graceful cancellation appends a result.
    // This models a lost executor's persisted input, not a real process-kill or SQLite recovery.
    await copyFile(join(original, name), join(snapshot, name));
    await session.abort(); await run.catch(() => {}); session.dispose(); session = undefined;
    restored = await createConversationSession({ ...options,
      storage: { directory: snapshot, id: 'g0-pending-session', restore: true } });
    expect(fixture.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(fixture.errors).toEqual([]);
    expect(await readFile(join(snapshot, name), 'utf8')).not.toContain('g0-synthetic-key');
  } finally {
    release('cleanup');
    await session?.abort(); await run?.catch(() => {});
    session?.dispose(); restored?.dispose();
    await fixture.close(); await rm(root, { recursive: true, force: true });
  }
});
