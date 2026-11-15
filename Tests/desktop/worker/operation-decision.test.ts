import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { applyOperationDecision } from '../../../apps/desktop/src/worker/operation-observation.js';

it.each([0, 1, 2])('preserves the AI denial threshold before increment: %s prior denials', (prior) => {
  const view: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'docker build .',
    status: 'proposed', createdAt: 1, effects: 'possible', readOnly: false };
  applyOperationDecision(view, { verdict: 'deny', ruleId: 'ai-review-deny', reason: 'Denied; [code-execution]' }, prior);
  expect(view).toMatchObject({ status: 'denied', reason: 'Denied; [code-execution]', ruleId: 'ai-review-deny',
    manualReviewAvailable: prior + 1 < 3, effects: 'possible', readOnly: false });
  expect(view.exitObserved).toBeUndefined(); expect(view.reconciledAt).toBeUndefined();
});

it('clears old manual review on approval without claiming completion', () => {
  const view: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'docker build .',
    status: 'denied', createdAt: 1, manualReviewAvailable: true };
  applyOperationDecision(view, { verdict: 'allow', ruleId: 'human-approved', reason: 'Exact approval' }, 0);
  expect(view).toMatchObject({ status: 'running', ruleId: 'human-approved', manualReviewAvailable: false });
  expect(view.exitObserved).toBeUndefined(); expect(view.reconciledAt).toBeUndefined();
});
