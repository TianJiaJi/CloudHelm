import { expect, it, vi } from 'vitest';
import type { SessionEvent } from '@cloudhelm/core';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { openAiFixture, fixtureMessageText } from './pi-session-fixture.js';

it('correlates same-text native steer/followUp receipts and awaits backend selection before the next request', async () => {
  let releaseReply!: () => void, releaseSelection!: () => void;
  const reply = new Promise<void>((resolve) => { releaseReply = resolve; });
  const selection = new Promise<void>((resolve) => { releaseSelection = resolve; });
  const selected: string[] = [], delivered: Array<{ id: string; entryId: string }> = [], events: SessionEvent[] = [];
  let calls = 0;
  const fixture = await openAiFixture(async () => { if (++calls === 1) await reply; return { text: 'synthetic answer' }; });
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: fixture.baseUrl },
    systemPrompt: 'Synthetic queue test.', tools: [], clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {},
    event: (event) => events.push(structuredClone(event)),
    inputSelected: async (input) => { selected.push(input.id); if (input.id === 'steer') await selection; },
    inputDelivered: async (id, entryId) => { delivered.push({ id, entryId }); } });
  try {
    const turn = session.prompt('initial');
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 15000 });
    session.queueInput!({ id: 'follow', kind: 'followUp', text: 'identical queued input' });
    session.queueInput!({ id: 'steer', kind: 'steer', text: 'identical queued input' });
    session.queueInput!({ id: 'cancel', kind: 'followUp', text: 'must never reach model' });
    expect(session.cancelQueuedInput!('cancel')).toBe(true);
    expect(selected).toEqual([]); expect(delivered).toEqual([]);
    releaseReply(); await vi.waitFor(() => expect(selected).toEqual(['steer']), { timeout: 15000 });
    expect(calls).toBe(1); expect(delivered).toEqual([]);
    releaseSelection(); await turn;
    expect(calls).toBe(3); expect(selected).toEqual(['steer', 'follow']);
    expect(delivered.map((value) => value.id)).toEqual(['steer', 'follow']);
    expect(new Set(delivered.map((value) => value.entryId)).size).toBe(2);
    const users = events.filter((event) => event.type === 'text' && event.value.role === 'user');
    expect(users.filter((event) => event.type === 'text' && event.value.text === 'identical queued input')).toHaveLength(2);
    expect(fixture.requests.flatMap((request) => request.messages.map(fixtureMessageText)).join('\n')).not.toContain('must never reach model');
  } finally { releaseReply(); releaseSelection(); await session.abort(); session.dispose(); await fixture.close(); }
});
