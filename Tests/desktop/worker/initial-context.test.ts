import { expect, it } from 'vitest';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { initialContext } from '../../../apps/desktop/src/worker/initial-context.js';
import { openAiFixture } from './openai-sse-fixture.js';
import { MessagePreparations } from '../../../apps/desktop/src/worker/message-preparations.js';

it('measures the full fresh native tool/frame with no model, SSH or selected-file reads', async () => {
  const fixture = await openAiFixture(async () => { throw new Error('Preview sent a model request'); });
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'private-fixture-key', baseUrl: fixture.baseUrl, contextWindow: 32000, maxTokens: 8192 };
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'disconnected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  try {
    const baseline = await initialContext(profile, [], [], new AbortController().signal);
    const scoped = await initialContext(profile, [host], [{ path: '/nonexistent/selected-file', kind: 'file' }], new AbortController().signal);
    expect(baseline).toMatchObject({ modelIdle: true, remoteIdle: true, hasHistory: false, budget: { source: 'estimate', outputReserve: 8192, safetyMargin: 640 } });
    expect(baseline.budget.usedTokens).toBeGreaterThan(4096);
    expect(scoped.budget.usedTokens).toBeGreaterThan(baseline.budget.usedTokens);
    expect(scoped.budget.availableInput).toBe(32000 - scoped.budget.usedTokens - 8192 - 640);
    expect(JSON.stringify(scoped)).not.toContain('private-fixture-key');
    expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
it('uses the fresh native frame instead of any legacy UI usedTokens estimate', async () => {
  const fixture = await openAiFixture(async () => { throw new Error('Unexpected request'); });
  try {
    const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture', baseUrl: fixture.baseUrl, contextWindow: 32000, maxTokens: 8192 };
    const jobs = new MessagePreparations({ request: async () => { throw new Error('Unexpected budget request'); } }, () => {});
    const result = await jobs.prepare({ method: 'prepare-message', requestId: 'fresh', document: { requestId: 'fresh', parts: [{ type: 'text', text: 'small' }] },
      bodies: [], profile, usedTokens: Number.MAX_SAFE_INTEGER });
    expect(result.text).toBe('small'); expect(result.preparedContext).toBeUndefined(); expect(fixture.requests).toHaveLength(0);
  } finally { await fixture.close(); }
});
it('canceled first-frame preparation never initializes a session or accesses a provider', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(initialContext({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture' }, [], [], controller.signal)).rejects.toThrow();
});
