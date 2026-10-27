import { expect, it, vi } from 'vitest';
import { meterModelRequest, modelRequestCapability } from './model-request-meter.js';
import type { ModelRequestAttempt } from '@cloudhelm/core';

it.each(['openai-completions', 'openai-responses', 'azure-openai-responses', 'anthropic-messages',
  'mistral-conversations', 'pi-messages', 'typesafe-system-one', 'cloudflare-workers-ai-system-one', 'llama-cpp-classify'])(
  'only marks the verified %s injection path as HTTP-visible', (api) => {
    expect(modelRequestCapability(api)).toEqual({ transport: 'http', automaticRetry: true });
  });
it('does not infer injection from a provider name or force a WebSocket route to HTTP', () => {
  expect(modelRequestCapability('google-generative-ai').transport).toBe('opaque');
  expect(modelRequestCapability('google-vertex').transport).toBe('opaque');
  expect(modelRequestCapability('bedrock-converse-stream').transport).toBe('opaque');
  expect(modelRequestCapability('openai').transport).toBe('opaque');
  expect(modelRequestCapability('new-api', 'sse').transport).toBe('opaque');
  expect(modelRequestCapability('openai-codex-responses', 'auto').transport).toBe('opaque');
  expect(modelRequestCapability('openai-codex-responses', 'websocket').transport).toBe('opaque');
  expect(modelRequestCapability('openai-codex-responses', 'sse').transport).toBe('http');
});
it('reserves at fetch rather than SDK preparation and preserves request bytes, target and headers', async () => {
  let release!: () => void; const ack = new Promise<void>((resolve) => { release = resolve; });
  const reserve = vi.fn(async (_attempt: ModelRequestAttempt, _signal?: AbortSignal) => ack); const fetch = vi.fn(async () => new Response('ok'));
  const meter = meterModelRequest({ api: 'openai-completions', purpose: 'conversation', reserve, fetch });
  await meter.beforeStream(); expect(reserve).not.toHaveBeenCalled();
  const init = { method: 'POST', headers: { authorization: 'Bearer fixture-only' }, body: 'immutable request body' };
  const sent = meter.fetch!('https://fixture.invalid/request', init);
  expect(reserve).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  release(); await sent;
  expect(fetch).toHaveBeenCalledWith('https://fixture.invalid/request', { ...init, headers: new Headers(init.headers), redirect: 'error' });
  const metadata = reserve.mock.calls[0]![0];
  expect(metadata).toMatchObject({ purpose: 'conversation', attempt: 1, transport: 'http' });
  expect(Object.keys(metadata).sort()).toEqual(['attempt', 'logicalRequestId', 'purpose', 'transport']);
  expect(JSON.stringify(metadata)).not.toContain('fixture-only');
  await expect(meter.fetch!('https://fixture.invalid/request', init)).rejects.toThrow('additional provider request');
  expect(fetch).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce();
});
it('never dispatches after a failed acknowledgment or late cancellation', async () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const failed = meterModelRequest({ api: 'openai-completions', purpose: 'compaction', fetch,
    reserve: async () => { throw new Error('durable confirmation missing'); } });
  await expect(failed.fetch!('https://fixture.invalid')).rejects.toThrow('durable confirmation missing');
  let release!: () => void; const ack = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const meter = meterModelRequest({ api: 'openai-completions', purpose: 'summary', fetch, signal: controller.signal, reserve: async () => ack });
  const pending = meter.fetch!('https://fixture.invalid');
  controller.abort(); release(); await expect(pending).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('combines the SDK request timeout with the parent cancellation for the reservation', async () => {
  const parent = new AbortController(); const provider = new AbortController();
  const reserve = vi.fn(async (_attempt: ModelRequestAttempt, signal?: AbortSignal) => { provider.abort(); expect(signal?.aborted).toBe(true); });
  const fetch = vi.fn(async () => new Response('ok'));
  const meter = meterModelRequest({ api: 'openai-completions', purpose: 'review', signal: parent.signal, reserve, fetch });
  await expect(meter.fetch!(new Request('https://fixture.invalid', { signal: provider.signal }))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(parent.signal.aborted).toBe(false);
});
it('reserves one explicitly opaque call without installing a fetch shim or enabling retries', async () => {
  const reserve = vi.fn();
  const meter = meterModelRequest({ api: 'google-generative-ai', purpose: 'conversation', reserve });
  expect(meter.fetch).toBeUndefined(); await meter.beforeStream();
  expect(reserve.mock.calls[0]?.[0]).toMatchObject({ transport: 'opaque', attempt: 1 });
  await expect(meter.beforeStream()).rejects.toThrow('automatic replay is disabled');
  expect(reserve).toHaveBeenCalledOnce();
});
it('does not retry unclassified transport failures or unproven replayable requests', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('network failure')).mockResolvedValueOnce(new Response('', { status: 503 }));
  const reserve = vi.fn();
  const first = meterModelRequest({ api: 'openai-completions', purpose: 'conversation', fetch, reserve });
  await expect(first.fetch!('https://fixture.invalid')).rejects.toThrow('network failure');
  const second = meterModelRequest({ api: 'openai-completions', purpose: 'conversation', fetch, reserve });
  expect((await second.fetch!('https://fixture.invalid')).status).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(2); expect(reserve).toHaveBeenCalledTimes(2);
  expect(reserve.mock.calls[0]?.[0].logicalRequestId).not.toBe(reserve.mock.calls[1]?.[0].logicalRequestId);
});
