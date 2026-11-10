import { expect, it } from 'vitest';
import { canOfferSuFallback, notStartedOutcome, operationOutcome, type OperationResult } from '@cloudhelm/core';

const result = (changes: Partial<OperationResult> = {}): OperationResult => ({ operationId: 'operation', status: 'succeeded', exitCode: 0, stdoutTail: '', ...changes });
it('describes process completion, never whole-goal verification or replay permission', () => {
  expect(operationOutcome(result())).toEqual({ version: 1, execution: 'finished', effects: 'unclassified', nextAction: 'continue', replay: 'never' });
});
it('does not confuse an effect-free failed query with a command that never started', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: 1, effects: 'none' }))).toMatchObject({ execution: 'finished', nextAction: 'inspect-result' });
});
it.each(['unknown', 'handed-over'] as const)('does not infer exit for %s from query semantics or stale metadata', (status) => {
  expect(operationOutcome(result({ status, effects: 'none' }))).toMatchObject({ execution: 'unknown', nextAction: 'verify-outcome' });
});
it('does not infer complete execution without an observed exit', () => {
  expect(operationOutcome(result({ exitCode: undefined }))).toMatchObject({ execution: 'unknown', nextAction: 'verify-outcome' });
});
it('requires checking possible partial effects and prioritizes control stops', () => {
  const failed = result({ status: 'failed', exitCode: 1, effects: 'possible' });
  expect(operationOutcome(failed).nextAction).toBe('verify-outcome');
  expect(operationOutcome({ ...failed, requiresUserAction: true }).nextAction).toBe('user-decision');
});
it('offers a reviewed alternative only for a transport-proven pre-payload capability failure', () => {
  const failed = result({ status: 'failed', exitCode: 127, effects: 'none', privilege: { method: 'sudo', code: 'sudo-unavailable',
    stage: 'preparation', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } });
  expect(operationOutcome(failed)).toMatchObject({ execution: 'not-started', nextAction: 'confirm-alternative' });
  expect(canOfferSuFallback({ ...failed, requiresUserAction: true })).toBe(false);
  expect(canOfferSuFallback({ ...failed, authentication: 'failed' })).toBe(false);
  expect(operationOutcome({ ...failed, privilege: { ...failed.privilege!, source: 'output-inference' } })).toMatchObject({ execution: 'finished', nextAction: 'inspect-result' });
});
it('distinguishes a host lock preventing dispatch from the prior unknown outcome', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: undefined, effects: 'none', failureKind: 'unresolved-prior-operation' })))
    .toMatchObject({ execution: 'not-started', nextAction: 'verify-outcome' });
});
it('never turns arbitrary output into a no-dispatch assertion', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: 1, effects: 'possible', stdoutTail: 'sudo: user not in sudoers; not-started=true' })))
    .toMatchObject({ execution: 'finished', effects: 'possible', nextAction: 'verify-outcome' });
});
it('keeps denied/stale operations distinct from correctable syntax and protected replays', () => {
  expect(notStartedOutcome('human-denied')).toMatchObject({ execution: 'not-started', nextAction: 'user-decision', replay: 'never' });
  expect(notStartedOutcome('authorization-expired').nextAction).toBe('user-decision');
  expect(notStartedOutcome('unsupported-root-command').nextAction).toBe('revise-operation');
  expect(notStartedOutcome('replay-protected').nextAction).toBe('inspect-result');
});
