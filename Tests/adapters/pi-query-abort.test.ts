import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { SessionEvent } from '@cloudhelm/core';
import { Type } from 'typebox';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

async function queriesReady(ready: Promise<void>, run: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready,
      run.then(() => { throw new Error('Native script settled before four query slots started'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native query readiness exceeded 10s')), 10_000); })]);
  } finally { clearTimeout(timer); }
}

it.each([0, 1250])('aborts pending native reads without another request or replay (fixture warmup %ims)', async (warmupMs) => {
  let release!: () => void, markReady!: () => void, started = 0, finished = 0, requests = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const execute = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
    if (++started === 4) markReady();
    try {
      await hold; signal?.throwIfAborted();
      return { content: [{ type: 'text' as const, text: 'late observation' }], details: undefined };
    } finally { finished++; }
  });
  const provider = await openAiFixture(async () => {
    if (++requests !== 1) return { text: 'Fresh explicit input only.' };
    // Explicitly cover startup slower than vi.waitFor's former 1s default.
    if (warmupMs) await delay(warmupMs);
    return { calls: [{ id: 'cancel-script', name: 'codemode', arguments: { code: 'await Promise.allSettled(Array.from({length:12}, () => tools.query({})));' } }] };
  });
  const events: SessionEvent[] = [];
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic cancellation, no SSH.', tools: [{ name: 'query', label: 'Query', description: 'Synthetic pending read',
      access: 'query', parameters: Type.Object({}, { additionalProperties: false }), replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(event)
  });
  const run = session.prompt('Run bounded queries').then(() => ({ failed: false }), () => ({ failed: true }));
  try {
    await queriesReady(ready, run);
    expect(execute).toHaveBeenCalledTimes(4);
    await session.abort();
    expect(await run).toEqual({ failed: true });
    expect(finished).toBe(0); expect(requests).toBe(1);
    expect(events).toContainEqual({ type: 'lifecycle', value: expect.objectContaining({ kind: 'run', status: 'settled', aborted: true }) });
    release(); await vi.waitFor(() => expect(finished).toBe(4));
    expect(execute).toHaveBeenCalledTimes(4); expect(requests).toBe(1);
    await session.prompt('Fresh explicit request');
    expect(requests).toBe(2); expect(execute).toHaveBeenCalledTimes(4);
  } finally { release(); await session.abort(); await run; session.dispose(); await provider.close(); }
});
