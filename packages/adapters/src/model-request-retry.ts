import { setTimeout as sleep } from 'node:timers/promises';
import type { FetchFunction } from '@earendil-works/pi-ai';

const statuses = new Set([408, 502, 503, 504]);
const rateCodes = new Set(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests']);
const transientCodes = new Set(['server_error', 'api_error', 'overloaded_error', 'timeout_error', 'service_unavailable', 'bad_gateway', 'gateway_timeout']);
const networkCodes = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const MAX_ERROR_BYTES = 4096;

function networkTransient(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (value.name === 'AbortError') return false;
  const code = value.code ?? value.cause?.code;
  return typeof code === 'string' && networkCodes.has(code);
}

/** Read a bounded clone only. No error body/header is logged or returned as
 * diagnostics. An unknown, oversized, malformed or stalled body is not retried. */
async function errorCodes(response: Response, signal?: AbortSignal): Promise<string[] | undefined> {
  const clone = response.clone(); const reader = clone.body?.getReader();
  if (!reader) return undefined;
  const deadline = AbortSignal.timeout(1000);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(stop.reason);
    stop.addEventListener('abort', cancel, { once: true });
    if (stop.aborted) cancel();
  });
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_ERROR_BYTES) return undefined;
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks, length);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || !('error' in parsed) || !parsed.error || typeof parsed.error !== 'object') return undefined;
    const error = parsed.error as { code?: unknown; type?: unknown };
    const codes = [error.code, error.type].filter((code) => code !== undefined && code !== null);
    return codes.every((code) => typeof code === 'string') ? codes as string[] : undefined;
  } catch { return undefined; }
  finally {
    stop.removeEventListener('abort', cancel);
    // Do not await one side of a tee: its cancellation can await the other side.
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

async function retryableResponse(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 429 && !statuses.has(response.status)) return false;
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return statuses.has(response.status);
  const codes = await errorCodes(response, signal);
  if (!codes) return false;
  // Explicit validation, quota, filtering, context, auth or unknown codes must
  // never be overridden by a misleading 5xx status.
  if (response.status === 429) return codes.length > 0 && codes.every((code) => rateCodes.has(code));
  return codes.every((code) => transientCodes.has(code));
}

function waitDuration(response: Response | undefined, attempt: number, random: () => number): number | undefined {
  const backoff = 250 * 2 ** (attempt - 1) + Math.floor(random() * 250);
  const header = response?.headers.get('retry-after');
  if (header === null || header === undefined) return backoff;
  if (header.length > 80) return undefined;
  const value = header.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds > 30_000) return undefined;
  return Math.max(0, milliseconds, backoff);
}

export interface RequestRetryOptions {
  fetch: FetchFunction;
  signal?: AbortSignal;
  assertActive(): void;
  reserve(attempt: number, signal?: AbortSignal): Promise<void>;
  /** Test seams, not user-configurable provider policy. */
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
}

/** One fixed JSON request only; never a prompt/agent/tool replay. No response
 * already delivered to the provider can be retried, including stream errors.
 * Unknown bodies/transports remain one-shot. Redirects cannot change target. */
export function requestWithSafeRetries(options: RequestRetryOptions): FetchFunction {
  return async (input, init) => {
    const signals = [options.signal, init?.signal, input instanceof Request ? input.signal : undefined]
      .filter((signal): signal is AbortSignal => !!signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const snapshot = { ...init, headers, ...(signal ? { signal } : {}), redirect: 'error' as const };
    const target = input instanceof URL ? input.toString() : input;
    const replayable = !(input instanceof Request) && typeof snapshot.body === 'string'
      && snapshot.method?.toUpperCase() === 'POST' && headers.get('content-type')?.toLowerCase().startsWith('application/json');
    const check = () => { signal?.throwIfAborted(); options.assertActive(); };
    const wait = options.wait ?? ((ms, activeSignal) => sleep(ms, undefined, { signal: activeSignal }));
    for (let attempt = 1; attempt <= 3; attempt++) {
      check(); await options.reserve(attempt, signal); check();
      let response: Response | undefined; let failure: unknown;
      try { response = await options.fetch(target, { ...snapshot, headers: new Headers(headers) }); }
      catch (error) { failure = error; }
      // Success is returned untouched. Nothing here consumes or retries its stream.
      if (response?.ok) return response;
      if (!replayable || attempt === 3) { if (response) return response; throw failure; }
      const retry = response ? await retryableResponse(response, signal) : networkTransient(failure);
      const duration = retry ? waitDuration(response, attempt, options.random ?? Math.random) : undefined;
      if (duration === undefined) { if (response) return response; throw failure; }
      if (response?.body) void response.body.cancel().catch(() => {});
      check(); await wait(duration, signal); check();
    }
    throw new Error('Model HTTP attempt limit reached');
  };
}
