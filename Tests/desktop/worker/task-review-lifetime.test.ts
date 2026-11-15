import { expect, it } from 'vitest';
import { ReviewInterruptedError } from '@cloudhelm/core';
import { TaskReviewLifetime } from '../../../apps/desktop/src/worker/task-review-lifetime.js';

it('revokes old generations without aborting a later explicit review', () => {
  const lifetime = new TaskReviewLifetime(), original = lifetime.signal();
  lifetime.invalidate();
  expect(original.aborted).toBe(true); expect(original.reason).toBeInstanceOf(ReviewInterruptedError);
  expect(original.reason.outcome).toBe('stale');
  const next = lifetime.signal(); expect(next.aborted).toBe(false);
  lifetime.invalidate('canceled');
  expect(next.reason.outcome).toBe('canceled'); expect(lifetime.signal().aborted).toBe(false);
});

it('never reopens review authority after disposal', () => {
  const lifetime = new TaskReviewLifetime(); lifetime.close();
  const closed = lifetime.signal(); expect(closed.aborted).toBe(true);
  lifetime.invalidate(); lifetime.close();
  expect(lifetime.signal()).toBe(closed); expect(closed.reason.outcome).toBe('canceled');
});
