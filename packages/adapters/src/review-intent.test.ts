import { expect, it } from 'vitest';
import { reviewIntent } from './review-intent.js';

it('reserves independent space for the original goal, latest input and latest answered constraints', () => {
  const result = reviewIntent({ goal: 'unused display', intent: { origin: 'explicit',
    originalGoal: 'ORIGINAL-START ' + 'x'.repeat(10_000) + ' ORIGINAL-END',
    currentInput: 'CURRENT-START ' + 'y'.repeat(10_000) + ' NEVER-RESTART-PRODUCTION',
    clarifications: Array.from({ length: 8 }, (_, index) => ({ id: `q${index}`, text: `QUESTION-${index} ` + 'z'.repeat(2000) + ` ANSWER-${index}` })) } });
  expect(result.originalGoal.text).toContain('ORIGINAL-START');
  expect(result.originalGoal.text).toContain('ORIGINAL-END');
  expect(result.currentInput.text).toContain('NEVER-RESTART-PRODUCTION');
  expect(result.currentInput.truncated).toBe(true);
  expect(result.omittedClarifications).toBe(4);
  expect(result.clarifications.map((item) => item.id)).toEqual(['q4', 'q5', 'q6', 'q7']);
  expect(result.clarifications.at(-1)?.text).toContain('ANSWER-7');
  expect(result.originalGoal.text.length).toBeLessThanOrEqual(800);
  expect(result.currentInput.text.length).toBeLessThanOrEqual(1200);
  expect(result.clarifications.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(1200);
});

it('marks legacy goal provenance and retains late constraints rather than only the prefix', () => {
  const result = reviewIntent({ goal: 'old goal ' + 'x'.repeat(4000) + ' NEVER DELETE PRODUCTION' });
  expect(result.origin).toBe('legacy');
  expect(result.currentInput.text).toContain('NEVER DELETE PRODUCTION');
  expect(result.originalGoal.truncated).toBe(true);
});

it('redacts before clipping and does not split UTF-16 surrogate pairs', () => {
  const result = reviewIntent({ goal: 'token=synthetic-secret\n' + '😀'.repeat(3000) + ' end constraint' });
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  expect(result.currentInput.text).toContain('end constraint');
  for (const character of result.currentInput.text) expect(character.length === 1 && /[\uD800-\uDFFF]/u.test(character)).toBe(false);
});
