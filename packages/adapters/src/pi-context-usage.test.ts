import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { piContextUsage } from './pi-context-usage.js';

const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], api: 'openai-completions',
  provider: 'openai', model: 'model', stopReason: 'stop', timestamp: 2,
  usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, reasoning: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

describe('Pi context usage', () => {
  it('uses the latest applicable request, never cumulative totals or duplicated cache/reasoning', () => {
    expect(piContextUsage([reply, { ...reply, timestamp: 3 }])).toEqual({ tokens: 460, source: 'provider' });
    expect(piContextUsage([{ ...reply, usage: { ...reply.usage, totalTokens: 0 } }]).tokens).toBe(460);
  });
  it('estimates trailing tool output and includes system/tool declarations without valid usage', () => {
    const result: Message = { role: 'toolResult', toolCallId: 'a', toolName: 'test', content: [{ type: 'text', text: 'a'.repeat(40) }], isError: false, timestamp: 3 };
    expect(piContextUsage([reply, result])).toEqual({ tokens: 470, source: 'estimate' });
    expect(piContextUsage([{ role: 'system', content: 'a'.repeat(80), timestamp: 1 }])).toEqual({ tokens: 20, source: 'estimate' });
  });
  it('discards stale usage after context changes without modifying source messages', () => {
    expect(piContextUsage([reply], true)).toEqual({ tokens: 1, source: 'estimate' });
    expect(reply.usage.totalTokens).toBe(460);
    expect(piContextUsage([{ ...reply, stopReason: 'error' }]).source).toBe('estimate');
    expect(piContextUsage([{ ...reply, stopReason: 'aborted' }]).source).toBe('estimate');
  });
});
