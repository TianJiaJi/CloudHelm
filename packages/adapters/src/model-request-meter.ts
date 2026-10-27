import { randomUUID } from 'node:crypto';
import { requestWithSafeRetries } from './model-request-retry.js';
import type { FetchFunction, Transport } from '@earendil-works/pi-ai';
import type { ModelRequestAttempt, RequestPurpose } from '@cloudhelm/core';

export type ReserveModelAttempt = (attempt: ModelRequestAttempt, signal?: AbortSignal) => void | Promise<void>;
export interface ModelRequestCapability {
  transport: 'http' | 'opaque';
  automaticRetry: boolean;
  reason?: 'unsupported-api' | 'websocket-transport';
}
// Verified against the pinned Pi 0.99.1 public fetch injection paths. Unknown
// APIs are NOT guessed from provider/model names or base URLs. Google currently
// rejects custom fetch; Codex auto/WebSocket can bypass it. Never force a route.
const httpApis = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
  'anthropic-messages', 'mistral-conversations', 'pi-messages',
  'typesafe-system-one', 'cloudflare-workers-ai-system-one', 'llama-cpp-classify']);
export function modelRequestCapability(api: string, transport?: Transport): ModelRequestCapability {
  if (api === 'openai-codex-responses') return transport === 'sse'
    ? { transport: 'http', automaticRetry: true }
    : { transport: 'opaque', automaticRetry: false, reason: 'websocket-transport' };
  return httpApis.has(api) ? { transport: 'http', automaticRetry: true }
    : { transport: 'opaque', automaticRetry: false, reason: 'unsupported-api' };
}

/** One SDK logical request with bounded, metered HTTP attempts.
 * HTTP reservations occur at the actual fetch boundary, not during prompt
 * assembly. Opaque routes are explicitly conservative logical reservations.
 * A second SDK dispatch is rejected rather than becoming an unmetered retry. */
export function meterModelRequest(options: {
  api: string; purpose: RequestPurpose; transport?: Transport; signal?: AbortSignal;
  reserve: ReserveModelAttempt; assertActive?(): void; failed?(error: unknown): void; fetch?: FetchFunction;
}): { capability: ModelRequestCapability; beforeStream(): Promise<void>; fetch?: FetchFunction } {
  const capability = modelRequestCapability(options.api, options.transport);
  const logicalRequestId = randomUUID();
  const actualFetch = options.fetch ?? globalThis.fetch;
  let claimed = false;
  const check = (signal?: AbortSignal) => {
    try { signal?.throwIfAborted(); options.assertActive?.(); }
    catch (error) { options.failed?.(error); throw error; }
  };
  const claim = () => {
    if (claimed) throw new Error('Unexpected additional provider request; automatic replay is disabled');
    claimed = true;
  };
  const reserve = async (attempt: number, signal?: AbortSignal): Promise<void> => {
    try {
      check(signal);
      await options.reserve(Object.freeze({ logicalRequestId, purpose: options.purpose, attempt, transport: capability.transport }), signal);
      check(signal);
    } catch (error) { options.failed?.(error); throw error; }
  };
  const retry = requestWithSafeRetries({ fetch: actualFetch, signal: options.signal, reserve,
    assertActive: () => check(options.signal) });
  const meteredFetch: FetchFunction = async (input, init) => { claim(); return retry(input, init); };
  return { capability, ...(capability.transport === 'http' ? { fetch: meteredFetch } : {}),
    beforeStream: async () => {
      check(options.signal);
      if (capability.transport === 'opaque') { claim(); await reserve(1, options.signal); }
    } };
}
