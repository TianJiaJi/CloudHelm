import { afterEach, expect, it } from 'vitest';
import { RequestBudgetError, type ModelRequestAttempt, type SessionEvent } from '@cloudhelm/core';
import { createConversationSession } from './pi-session.js';
import { openAiFixture } from './pi-session-fixture.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(reply: Parameters<typeof openAiFixture>[0], before?: (attempt: ModelRequestAttempt) => void) {
  const fixture = await openAiFixture(reply); cleanups.push(fixture.close);
  const attempts: ModelRequestAttempt[] = []; const events: SessionEvent[] = []; let generation = 'one';
  const session = await createConversationSession({ profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    systemPrompt: 'Local retry fixture', tools: [], clarification: { ask: async () => [] }, assertActive() {},
    requestGeneration: () => generation, beforeRequest: (_purpose, _profile, attempt) => { before?.(attempt); attempts.push(attempt); }, event: (event) => events.push(event) });
  cleanups.push(() => session.dispose());
  return { fixture, session, attempts, events, change: () => { generation = 'two'; } };
}
it('retries one fixed serialized native HTTP request with distinct charged attempts, not a new prompt', async () => {
  let count = 0;
  const f = await setup(async () => ++count === 1 ? { error: 'temporary gateway error', status: 502 } : { text: 'answer' });
  await f.session.prompt('Explain without tools');
  expect(f.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  expect(new Set(f.attempts.map((attempt) => attempt.logicalRequestId)).size).toBe(1);
  expect(f.fixture.requests).toHaveLength(2);
  expect(f.fixture.requests[0]).toEqual(f.fixture.requests[1]);
  expect(f.session.lastTurnAnswered).toBe(true);
  const responses = f.events.filter((event) => event.type === 'response');
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({ attempt: { logicalRequestId: f.attempts[0]!.logicalRequestId, attempt: 2, purpose: 'conversation' }, status: 'stop' });
});
it('stops before a retry whose durable reservation is refused', async () => {
  const refusal = new RequestBudgetError('budget-exhausted');
  const f = await setup(async () => ({ error: 'temporary gateway error', status: 503 }), (attempt) => {
    if (attempt.attempt > 1) throw refusal;
  });
  await expect(f.session.prompt('Explain')).rejects.toBe(refusal);
  expect(f.attempts).toHaveLength(1); expect(f.fixture.requests).toHaveLength(1);
});
it('never retries authentication failure or switches credentials', async () => {
  const f = await setup(async () => ({ error: 'invalid authentication', status: 401 }));
  await expect(f.session.prompt('Explain')).rejects.toThrow();
  expect(f.attempts).toHaveLength(1); expect(f.fixture.requests).toHaveLength(1);
  expect(f.fixture.requests[0]?.authorization).toBe('Bearer fixture-only');
});
it('cancels retries when backend policy changes after the first response', async () => {
  const f = await setup(async () => { f.change(); return { error: 'temporary gateway error', status: 503 }; });
  await expect(f.session.prompt('Explain')).rejects.toThrow('策略已变更');
  expect(f.attempts).toHaveLength(1); expect(f.fixture.requests).toHaveLength(1);
});
