import { expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { fixtureMessageText, openAiFixture } from './pi-session-fixture.js';

it.each(['allowed', 'unavailable', 'revoked'] as const)('filters native deferred discovery and rechecks actual dispatch: %s', async (mode) => {
  let allowed = mode !== 'unavailable', count = 0;
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'owned lookup result' }], details: undefined,
    structuredContent: { version: 1, state: 'observed' } }));
  const provider = await openAiFixture(async () => {
    count++;
    if (count === 1) return { calls: [{ id: 'search', name: 'tool_search', arguments: { query: 'unique needle observation', limit: 1 } }] };
    if (count === 2) {
      if (mode === 'revoked') allowed = false;
      return { calls: [{ id: 'lookup-call', name: 'lookup', arguments: {} }] };
    }
    return { text: 'Reported only authorized observations.' };
  });
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic-only', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic scoped discovery, no SSH.', tools: [{ name: 'lookup', label: 'Lookup', description: 'unique needle observation SECRET_METADATA_MARKER',
      access: 'query', deferred: true, available: () => allowed, parameters: Type.Object({}, { additionalProperties: false }), replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {}
  });
  try {
    await session.prompt('Find the available observation');
    expect(provider.requests).toHaveLength(3);
    const names = (index: number) => provider.requests[index]!.tools?.map((tool) => tool.function.name) ?? [];
    expect(names(0)).not.toContain('lookup');
    if (mode === 'allowed') { expect(names(1)).toContain('lookup'); expect(execute).toHaveBeenCalledOnce(); }
    else {
      expect(execute).not.toHaveBeenCalled(); expect(names(2)).not.toContain('lookup');
      if (mode === 'unavailable') {
        expect(JSON.stringify(provider.requests)).not.toContain('SECRET_METADATA_MARKER');
        expect(provider.requests[1]!.messages.map(fixtureMessageText).join('\n')).toContain('No matching tools');
      }
    }
  } finally { session.dispose(); await provider.close(); }
});

it('discards staged cache writes if authorization changes after VM completion', async () => {
  let generation = 0, count = 0, changeOnce = true;
  const provider = await openAiFixture(async () => {
    count++;
    if (count === 1) return { calls: [{ id: 'save', name: 'codemode', arguments: { code: 'store("page", {operationId:"owned", cursor:9});' } }] };
    if (count === 3) return { calls: [{ id: 'load', name: 'codemode', arguments: { code: 'return {value:typeof load("page")};' } }] };
    return { text: 'No further actions.' };
  });
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic-only', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic cache transaction.', tools: [], requestGeneration: () => String(generation),
    queryReferenceAllowed: () => { if (changeOnce) { changeOnce = false; generation++; } return true; },
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {}
  });
  try {
    await session.prompt('Attempt to cache a cursor'); await session.prompt('Inspect the discarded transaction');
    expect(provider.requests).toHaveLength(4);
    const last = provider.requests[3]!.messages.filter((message) => message.role === 'tool').at(-1)!;
    expect(fixtureMessageText(last)).toMatch(/"value"\s*:\s*"undefined"/u);
  } finally { session.dispose(); await provider.close(); }
});

it('keeps the query cache bounded and filters references revoked between explicit turns', async () => {
  let allowed = true, count = 0;
  const provider = await openAiFixture(async () => {
    count++;
    if (count === 1) return { calls: [{ id: 'save', name: 'codemode', arguments: { code: 'store("page", {operationId:"owned", cursor:9}); return "saved";' } }] };
    if (count === 3) return { calls: [{ id: 'load', name: 'codemode', arguments: { code: 'return {value:typeof load("page")};' } }] };
    return { text: 'No further actions.' };
  });
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic-only', baseUrl: provider.baseUrl },
    systemPrompt: 'Synthetic cache; no local files or SSH.', tools: [], queryReferenceAllowed: (id) => allowed && id === 'owned',
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {}
  });
  try {
    await session.prompt('Cache the owned log cursor'); allowed = false;
    await session.prompt('Inspect the now-revoked cache');
    expect(provider.requests).toHaveLength(4);
    const last = provider.requests[3]!.messages.filter((message) => message.role === 'tool').at(-1)!;
    expect(fixtureMessageText(last)).toMatch(/"value"\s*:\s*"undefined"/u);
  } finally { session.dispose(); await provider.close(); }
});
