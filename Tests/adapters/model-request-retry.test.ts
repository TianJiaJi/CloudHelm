import { expect, it, vi } from 'vitest';
import { requestWithSafeRetries } from '../../packages/adapters/src/model-request-retry.js';

const init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, body: '{"model":"fixed"}' };
function setup(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => { const next = responses.shift(); if (next instanceof Error) throw next; return next!; });
  const reserve = vi.fn(async (_attempt: number, _signal?: AbortSignal) => {});
  const wait = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => {}); const assertActive = vi.fn();
  return { fetch, reserve, wait, assertActive, request: requestWithSafeRetries({ fetch, reserve, wait, assertActive, random: () => 0 }) };
}
it('charges initial plus at most two safe HTTP retries and returns the final response', async () => {
  const final = new Response('still unavailable', { status: 503 });
  const f = setup([new Response('one', { status: 502 }), new Response('two', { status: 504 }), final]);
  expect(await f.request('http://fixture.invalid/model', init)).toBe(final);
  expect(f.reserve.mock.calls.map((args) => args[0])).toEqual([1, 2, 3]);
  expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.wait).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 400, 409, 422, 500, 501, 301])('never retries HTTP %s', async (status) => {
  const response = new Response('not retried', { status }); const f = setup([response]);
  expect(await f.request('http://fixture.invalid/model', init)).toBe(response);
  expect(f.reserve).toHaveBeenCalledOnce(); expect(f.wait).not.toHaveBeenCalled();
});
it.each(['insufficient_quota', 'credit_balance_too_low', 'billing_hard_limit_reached', 'unknown'])('does not retry 429 code %s', async (code) => {
  const response = Response.json({ error: { code } }, { status: 429 }); const f = setup([response]);
  expect(await f.request('http://fixture.invalid/model', init)).toBe(response);
  expect(await response.json()).toEqual({ error: { code } });
  expect(f.fetch).toHaveBeenCalledOnce();
});
it.each(['context_length_exceeded', 'content_filter', 'invalid_request_error', 'insufficient_quota', 'unknown'])('does not let HTTP 503 override error code %s', async (code) => {
  const response = Response.json({ error: { code } }, { status: 503 }); const f = setup([response]);
  expect(await f.request('http://fixture.invalid/model', init)).toBe(response);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.wait).not.toHaveBeenCalled();
});
it('retries only explicit rate-limit metadata, respects Retry-After and releases discarded bodies', async () => {
  const rate = Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '2' } });
  const ok = new Response('ok'); const f = setup([rate, ok]);
  expect(await f.request('http://fixture.invalid/model', init)).toBe(ok);
  expect(f.wait).toHaveBeenCalledWith(2000, undefined); expect(rate.bodyUsed).toBe(true);
});
it('does not follow long retry delays, oversized bodies or conflicting quota metadata', async () => {
  for (const response of [new Response('busy', { status: 503, headers: { 'retry-after': '31' } }),
    Response.json({ error: { code: 'rate_limit_exceeded', type: 'insufficient_quota' } }, { status: 429 }),
    Response.json({ error: { code: 'rate_limit_exceeded' }, padding: 'x'.repeat(4096) }, { status: 429 })]) {
    const f = setup([response]); expect(await f.request('http://fixture.invalid/model', init)).toBe(response);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.wait).not.toHaveBeenCalled();
  }
});
it('retries known network errors but not unknown errors or a delivered successful stream', async () => {
  const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const f = setup([failure, new Response('ok')]); await f.request('http://fixture.invalid/model', init);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  const unknown = setup([new TypeError('unknown')]);
  await expect(unknown.request('http://fixture.invalid/model', init)).rejects.toThrow('unknown');
  expect(unknown.fetch).toHaveBeenCalledOnce();
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream disconnected')); } }));
  const stream = setup([broken]); const delivered = await stream.request('http://fixture.invalid/model', init);
  await expect(delivered.text()).rejects.toThrow('stream disconnected'); expect(stream.fetch).toHaveBeenCalledOnce();
});
it('freezes target, credentials and request bytes across caller mutation during backoff', async () => {
  const target = new URL('http://fixture.invalid/original'); const original = { ...init, headers: { ...init.headers } };
  const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const request = requestWithSafeRetries({ assertActive() {}, reserve: async () => {},
    fetch: async (url, options) => {
      seen.push({ url: String(url), body: options?.body, auth: new Headers(options?.headers).get('authorization') });
      return new Response('fixture', { status: seen.length === 1 ? 503 : 200 });
    }, wait: async () => { target.pathname = '/changed'; original.body = 'changed'; original.headers.authorization = 'changed'; } });
  await request(target, original);
  expect(seen).toEqual(Array(2).fill({ url: 'http://fixture.invalid/original', body: init.body, auth: 'Bearer fixture' }));
});
it('does not retry unproven replayable bodies', async () => {
  const response = new Response('busy', { status: 503 }); const f = setup([response]);
  expect(await f.request(new Request('http://fixture.invalid/model', init))).toBe(response);
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('rechecks cancellation and policy after backoff, without charging or sending another attempt', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => new Response('busy', { status: 503 })); const reserve = vi.fn(async () => {});
  const request = requestWithSafeRetries({ fetch, reserve, signal: controller.signal, assertActive() {},
    wait: async () => { controller.abort(); } });
  await expect(request('http://fixture.invalid/model', init)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce();
  let active = true;
  const changed = requestWithSafeRetries({ fetch, reserve, assertActive() { if (!active) throw new Error('policy changed'); },
    wait: async () => { active = false; } });
  await expect(changed('http://fixture.invalid/model', init)).rejects.toThrow('policy changed');
  expect(fetch).toHaveBeenCalledTimes(2);
});
