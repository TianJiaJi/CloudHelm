import { expect, it } from 'vitest';
import { operationFeedback } from './operation-feedback.js';
it('keeps successful retry warnings out of model output while explaining the final outcome', () => {
  const result = { operationId: 'op', status: 'succeeded' as const, exitCode: 0, authentication: 'succeeded' as const,
    stdoutTail: 'Sorry, try again.\nNETWORK ID NAME\n' };
  const feedback = operationFeedback(result, 'host');
  expect(feedback).toContain('Authentication: succeeded'); expect(feedback).toContain('NETWORK ID NAME');
  expect(feedback).not.toContain('Sorry, try again.'); expect(feedback).toContain('do not test sudo');
  expect(result.stdoutTail).toContain('Sorry, try again.');
});
it('describes a non-interactive password requirement as recoverable', () => {
  expect(operationFeedback({ operationId: 'probe', status: 'failed', authentication: 'required', stdoutTail: '', effects: 'none' }, 'host'))
    .toContain('not a rejected password');
});
