import type { Model } from '@earendil-works/pi-ai';

/** Leave room for input even when a catalog advertises output near the whole context window. */
export function conversationOutputTokens(model: Pick<Model<any>, 'contextWindow' | 'maxTokens'>): number {
  return Math.max(1, Math.min(model.maxTokens, Math.floor(model.contextWindow / 2)));
}
