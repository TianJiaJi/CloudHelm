import type { Message, TranscriptContext } from '@earendil-works/pi-ai';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

/** SDK usage includes cached tokens. Never add cache or reasoning a second time. */
export function piContextUsage(context: TranscriptContext | readonly Message[], discardUsage = false): {
  tokens: number; source: 'provider' | 'estimate';
} {
  const messages = 'messages' in context ? context.messages : context;
  const current = discardUsage ? messages.map((message): Message => message.role === 'assistant'
    ? { ...message, usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }
    : message) : messages;
  const estimate = estimateContextTokens(current);
  return { tokens: estimate.tokens,
    source: estimate.lastUsageIndex !== null && estimate.trailingTokens === 0 ? 'provider' : 'estimate' };
}
