import { expect, it } from 'vitest';
import { contextBudget, estimateTextTokens, outputTokenReserve } from './context-budget.js';
const input = { contextWindow: 10000, maxOutputTokens: 2000, historyTokens: 3000, frameTokens: 500 };
it('accounts for active history, system/tools/facts, output and safety margin', () => {
  expect(contextBudget(input)).toEqual({ contextWindow: 10000, usedTokens: 3500, outputReserve: 2000, safetyMargin: 200, availableInput: 4300, source: 'estimate' });
});
it('prefers valid provider usage but adds newly introduced frame content', () => {
  expect(contextBudget({ ...input, providerUsedTokens: 1000, previousFrameTokens: 300 })).toMatchObject({ usedTokens: 1200, source: 'provider' });
  expect(contextBudget({ ...input, providerUsedTokens: 1000 })).toMatchObject({ usedTokens: 1500 });
});
it('does not treat zero/unknown usage as an empty conversation', () => {
  for (const providerUsedTokens of [undefined, 0, NaN, -1]) expect(contextBudget({ ...input, providerUsedTokens }).usedTokens).toBe(3500);
});
it('reserves output consistently and fails closed for invalid capacities', () => {
  expect(outputTokenReserve(10000, 9000)).toBe(5000);
  expect(contextBudget({ ...input, historyTokens: 20000 }).availableInput).toBe(0);
  expect(() => contextBudget({ ...input, frameTokens: Infinity })).toThrow();
  expect(() => outputTokenReserve(0, 1)).toThrow();
});
it('estimates Chinese, code and multibyte content from UTF-8 rather than English character ratios', () => {
  expect(estimateTextTokens('汉字')).toBe(3); expect(estimateTextTokens('😀')).toBe(2);
  expect(estimateTextTokens('const x = 1;')).toBe(6);
});
