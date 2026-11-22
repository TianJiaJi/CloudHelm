import { expect, it } from 'vitest';
import { reviewCoordination } from '../../../apps/desktop/src/worker/review-coordination.js';

it('keeps correctable and per-operation refusals inside the round', () => {
  expect(reviewCoordination({ verdict: 'allow', ruleId: 'low-risk-command' })).toBe('none');
  expect(reviewCoordination({ verdict: 'ask', ruleId: 'uncertain-command' })).toBe('none');
  expect(reviewCoordination({ verdict: 'evaluate', ruleId: 'high-impact-command' })).toBe('none');
  // Request errors are the model's to fix; nothing was dispatched.
  expect(reviewCoordination({ verdict: 'error', ruleId: 'parse-failed' })).toBe('none');
  expect(reviewCoordination({ verdict: 'error', ruleId: 'authorization-expired' })).toBe('none');
  // Independent review denial is per-operation feedback with an exact manual-review path.
  expect(reviewCoordination({ verdict: 'deny', ruleId: 'ai-review-deny' })).toBe('none');
});

it('pauses the round for policy refusals and unresolved safety components', () => {
  expect(reviewCoordination({ verdict: 'deny', ruleId: 'system-blacklist' })).toBe('pause-round');
  expect(reviewCoordination({ verdict: 'deny', ruleId: 'credential-resource' })).toBe('pause-round');
  expect(reviewCoordination({ verdict: 'deny', ruleId: 'human-denied' })).toBe('diagnosis-only');
  expect(reviewCoordination({ verdict: 'error', ruleId: 'continuation-read-only' })).toBe('none');
  expect(reviewCoordination({ verdict: 'error', ruleId: 'approval-expired' })).toBe('pause-round');
  expect(reviewCoordination({ verdict: 'error', ruleId: 'analyzer-unavailable' })).toBe('pause-round');
  expect(reviewCoordination({ verdict: 'error', ruleId: 'policy-unavailable' })).toBe('pause-round');
});
