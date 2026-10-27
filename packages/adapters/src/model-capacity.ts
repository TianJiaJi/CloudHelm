import type { Model } from '@earendil-works/pi-ai';
import { outputTokenReserve } from '@cloudhelm/core';

/** Leave room for input even when a catalog advertises output near the whole context window. */
export function conversationOutputTokens(model: Pick<Model<any>, 'contextWindow' | 'maxTokens'>): number {
  return outputTokenReserve(model.contextWindow, model.maxTokens);
}
