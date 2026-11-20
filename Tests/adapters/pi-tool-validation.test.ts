import { afterEach, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { assertStrictToolArguments, assertUnchangedToolArguments, toPiTool } from '../../packages/adapters/src/pi-tool-validation.js';
import { createConversationSession } from '../../packages/adapters/src/pi-session.js';
import { fixtureMessageText, openAiFixture } from './pi-session-fixture.js';

const schema = Type.Object({ command: Type.String({ minLength: 1 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
  paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), enabled: Type.Boolean() }, { additionalProperties: false });
const valid = { command: 'inspect-service', port: 8080, paths: ['/srv/app'], enabled: false };
const invalid = [
  { ...valid, command: null }, { ...valid, command: 42 }, { ...valid, port: '8080' },
  { ...valid, port: '3.5' }, { ...valid, port: 3.5 }, { ...valid, port: 0 }, { ...valid, port: 65536 },
  { ...valid, paths: '/srv/app' }, { ...valid, paths: [null] }, { ...valid, enabled: 'false' },
  { ...valid, extra: 'not declared' }
];

it.each(invalid)('rejects invalid raw types/constraints without coercion (%j)', (args) => {
  expect(() => assertStrictToolArguments(schema, args)).toThrow('未执行');
});
it('rejects changed valid arguments and unsupported schemas without echoing values', () => {
  expect(() => assertUnchangedToolArguments(schema, valid, { ...valid, port: 9090 })).toThrow('发生变化');
  expect(() => assertStrictToolArguments({ type: 'unsupported-schema' }, 'synthetic-private-value')).toThrow('未执行');
  try { assertStrictToolArguments(schema, { ...valid, enabled: 'synthetic-private-value' }); }
  catch (error) { expect(String(error)).not.toContain('synthetic-private-value'); }
  expect(() => assertUnchangedToolArguments(schema, valid, structuredClone(valid))).not.toThrow();
});
it('rejects invalid nested schema types but does not reinterpret literal data as a schema', () => {
  expect(() => assertStrictToolArguments({ type: 'object', properties: { x: { type: 'unsupported' } } }, { x: 'value' })).toThrow('未执行');
  expect(() => assertStrictToolArguments({ type: 'array', items: { type: 'unsupported' } }, ['value'])).toThrow('未执行');
  expect(() => assertStrictToolArguments({ anyOf: [{ type: 'unsupported' }] }, 1)).toThrow('未执行');
  expect(() => assertStrictToolArguments(Type.Object({ value: Type.Literal('unsupported-schema') }), { value: 'unsupported-schema' })).not.toThrow();
});
it('reports field-level failures: path, constraint and received type, never raw values', () => {
  try { assertStrictToolArguments(schema, { ...valid, port: 'synthetic-secret-port' }); throw new Error('expected rejection'); }
  catch (error) {
    const text = String(error);
    expect(text).toContain('未执行');
    expect(text).toContain('/port');
    expect(text).toContain('"constraint":"type"');
    expect(text).toContain('"received":"string"');
    expect(text).not.toContain('synthetic-secret-port');
  }
});
it('caps failure items at three and reports received JSON types only', () => {
  try {
    assertStrictToolArguments(schema, { command: 42, port: 'x', paths: 5, enabled: 'no', extra: 'raw-value' });
    throw new Error('expected rejection');
  } catch (error) {
    const items = JSON.parse(String(error).match(/失败项：(\[.*\])$/u)![1]!) as Array<{ path: string; constraint: string; received: string }>;
    expect(items.length).toBeLessThanOrEqual(3);
    for (const item of items) {
      expect(typeof item.path).toBe('string');
      expect(typeof item.constraint).toBe('string');
      expect(['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined']).toContain(item.received);
    }
    expect(String(error)).not.toContain('raw-value');
  }
});
it('reports the root path for a non-object payload', () => {
  try { assertStrictToolArguments(schema, 'synthetic-scalar'); throw new Error('expected rejection'); }
  catch (error) { expect(String(error)).toContain('(root)'); expect(String(error)).not.toContain('synthetic-scalar'); }
});
it('revalidates at the actual tool entry after extension preflight', async () => {
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }));
  const tool = toPiTool({ name: 'inspect', label: 'Inspect', description: 'Inspect', parameters: schema, replay: 'never', execute });
  const invoke = (args: unknown) => tool.execute('call', args, new AbortController().signal, undefined, {} as never);
  await expect(invoke({ ...valid, port: '8080' })).rejects.toThrow('未执行');
  expect(execute).not.toHaveBeenCalled();
  await invoke(valid);
  expect(execute).toHaveBeenCalledOnce();
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function run(args: unknown, rawArguments?: string) {
  let count = 0;
  const fixture = await openAiFixture(async () => ++count === 1
    ? { calls: [{ id: 'strict-call', name: 'inspect', arguments: args, rawArguments }] }
    : { text: 'Reported the actual tool result.' });
  cleanup.push(fixture.close);
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'observed' }], details: undefined }));
  const session = await createConversationSession({
    profile: { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic-only', baseUrl: fixture.baseUrl },
    systemPrompt: 'No SSH. Only a synthetic tool.',
    tools: [{ name: 'inspect', label: 'Inspect', description: 'Inspect once', parameters: schema, replay: 'never', execute }],
    clarification: { ask: async () => [] }, assertActive() {}, beforeRequest() {}, event() {}
  });
  cleanup.push(() => session.dispose());
  await session.prompt('Inspect the synthetic service');
  return { fixture, execute };
}
it.each(invalid)('blocks real SDK SSE tool dispatch for invalid raw input (%j)', async (args) => {
  const { execute, fixture } = await run(args);
  expect(execute).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(2);
  const error = fixture.requests[1]!.messages.find((message) => message.role === 'tool');
  expect(error).toBeDefined();
  expect(fixtureMessageText(error!)).not.toBe('observed');
});
it('does not execute a truncated/malformed final tool call using only parsed fields', async () => {
  const { execute, fixture } = await run(valid, JSON.stringify(valid).slice(0, -1) + ', "extra":');
  expect(execute).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(2);
});
it('executes correctly typed arguments once, unchanged', async () => {
  const { execute, fixture } = await run(valid);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]).toEqual(['strict-call', valid, expect.any(AbortSignal)]);
  expect(fixture.requests).toHaveLength(2);
});
