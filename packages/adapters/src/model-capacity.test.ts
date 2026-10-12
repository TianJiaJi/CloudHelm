import { describe, expect, it } from 'vitest';
import { conversationOutputTokens } from './model-capacity.js';

describe('conversation output budget', () => {
  it('honors model output capacity above 8192 when context allows it', () => {
    expect(conversationOutputTokens({ contextWindow: 1_000_000, maxTokens: 384_000 })).toBe(384_000);
    expect(conversationOutputTokens({ contextWindow: 32_000, maxTokens: 8192 })).toBe(8192);
  });

  it('leaves input room for a model whose advertised output approaches its full context', () => {
    expect(conversationOutputTokens({ contextWindow: 16_000, maxTokens: 15_000 })).toBe(8000);
  });
});
