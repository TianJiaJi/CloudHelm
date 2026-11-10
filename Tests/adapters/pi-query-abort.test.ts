import { expect, it, vi } from 'vitest';
import type { SessionEvent } from '@cloudhelm/core';
import { Type } from 'typebox';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

it('aborts the native script without another model request or replay, even while reads are still pending', async () => {
  let release!: () => void, finished = 0, requests = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const execute = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
    try {
      await hold; signal?.throwIfAborted();
      return { content: [{ type: 'text' as const, text: 'late observation' }], details: undefined };
    } finally { finished++; }
  });
  const provider = await openAiFixture(async () => ++requests === 1
    ? { calls: [{ id: 'cancel-script', name: 'codemode', arguments: { code: 'await Promise.allSettled(Array.from({length:12}, () => tools.query({})));' } }] }
    : { text: 'Fresh explicit input only.' });
  const events: SessionEvent[] = [];
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic cancellation, no SSH.', tools: [{ name: 'query', label: 'Query', description: 'Synthetic pending read',
      access: 'query', parameters: Type.Object({}, { additionalProperties: false }), replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event: (event) => events.push(event)
  });
  const run = session.prompt('Run bounded queries').then(() => ({ failed: false }), () => ({ failed: true }));
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
    await session.abort();
    expect(await run).toEqual({ failed: true });
    expect(finished).toBe(0); expect(requests).toBe(1);
    expect(events).toContainEqual({ type: 'lifecycle', value: expect.objectContaining({ kind: 'run', status: 'settled', aborted: true }) });
    release(); await vi.waitFor(() => expect(finished).toBe(4));
    expect(execute).toHaveBeenCalledTimes(4); expect(requests).toBe(1);
    await session.prompt('Fresh explicit request');
    expect(requests).toBe(2); expect(execute).toHaveBeenCalledTimes(4);
  } finally { release(); await run; session.dispose(); await provider.close(); }
});
