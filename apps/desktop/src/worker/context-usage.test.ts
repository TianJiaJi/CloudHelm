import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ContextUsageView } from '@cloudhelm/contracts';
import { ContextUsageTracker } from './context-usage.js';

const model = { provider: 'openai', modelId: 'one' };
const response: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider: 'openai', model: 'one',
  api: 'openai-completions', stopReason: 'stop', timestamp: 2,
  usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 0, totalTokens: 200,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const context = { messages: [{ role: 'user' as const, content: 'a'.repeat(40), timestamp: 1 }] };
function setup() {
  const values: ContextUsageView[] = [];
  return { values, tracker: new ContextUsageTracker((value) => values.push(value)) };
}
describe('request context usage', () => {
  it('publishes transformed input, then provider usage, and invalidates across model switches', () => {
    const { values, tracker } = setup();
    tracker.begin(context, model, 1000, 1, false);
    expect(values.at(-1)).toMatchObject({ usedTokens: 10, source: 'estimate', contextWindow: 1000, request: 1 });
    tracker.complete(response);
    expect(values.at(-1)).toMatchObject({ usedTokens: 200, source: 'provider' });
    tracker.invalidate({ ...model, modelId: 'two' });
    tracker.complete(response);
    expect(values.at(-1)).toMatchObject({ usedTokens: null, source: 'unknown', model: { modelId: 'two' } });
    tracker.begin({ messages: [...context.messages, response] }, { ...model, modelId: 'two' }, 500, 2, false);
    expect(values.at(-1)).toMatchObject({ usedTokens: 11, source: 'estimate', contextWindow: 500 });
  });
  it('does not reuse pre-compaction usage, even when kept messages include an old assistant', () => {
    const { values, tracker } = setup();
    tracker.begin(context, model, 1000, 1, false); tracker.complete(response);
    tracker.begin({ messages: [...context.messages, response] }, model, 1000, 2, true);
    expect(values.at(-1)).toMatchObject({ usedTokens: 11, source: 'estimate' });
    tracker.complete({ ...response, timestamp: 4, usage: { ...response.usage, input: 50, totalTokens: 80 } });
    expect(values.at(-1)).toMatchObject({ usedTokens: 80, source: 'provider' });
  });
  it('does not replace valid estimates with failed responses and reports invalid windows as unknown', () => {
    const { values, tracker } = setup();
    tracker.begin(context, model, 1000, 1, false);
    tracker.complete({ ...response, stopReason: 'error' });
    tracker.complete({ ...response, stopReason: 'aborted' });
    expect(values).toHaveLength(1);
    tracker.begin(context, model, 0, 2, false);
    expect(values.at(-1)).toMatchObject({ usedTokens: null, contextWindow: null, source: 'unknown' });
  });
});
