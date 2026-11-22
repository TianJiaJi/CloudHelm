import { expect, it } from 'vitest';
import { canOfferSuFallback, notStartedOutcome, operationOutcome, type OperationResult } from '@cloudhelm/core';

const result = (changes: Partial<OperationResult> = {}): OperationResult => ({ operationId: 'operation', status: 'succeeded', exitCode: 0, stdoutTail: '', ...changes });
it('describes process completion, never whole-goal verification or replay permission', () => {
  expect(operationOutcome(result())).toEqual({ version: 2, receipt: 'done', handoff: 'unknown', businessStart: 'unknown',
    liveness: 'exited', exit: 0, effects: 'unclassified', nextActions: ['continue'], replay: 'never' });
});
it('does not confuse an effect-free failed query with a command that never started', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: 1, effects: 'none' }))).toMatchObject({ receipt: 'done',
    handoff: 'unknown', businessStart: 'unknown', liveness: 'exited', exit: 1, effects: 'none', nextActions: ['inspect-result'] });
});
it('keeps an unresolved status a settled call with unknown facts, not a running claim', () => {
  expect(operationOutcome(result({ status: 'unknown' }))).toMatchObject({ receipt: 'done', liveness: 'unknown', exit: null, nextActions: ['verify-outcome'] });
});
it('reports a handed-over command as running without inventing an exit', () => {
  expect(operationOutcome(result({ status: 'handed-over' }))).toMatchObject({ receipt: 'running', liveness: 'unknown', exit: null, nextActions: ['verify-outcome'] });
});
it('does not infer complete execution without an observed exit', () => {
  expect(operationOutcome(result({ exitCode: undefined }))).toMatchObject({ receipt: 'done', liveness: 'unknown', exit: null, nextActions: ['verify-outcome'] });
});
it('requires checking possible partial effects and prioritizes control stops', () => {
  const failed = result({ status: 'failed', exitCode: 1, effects: 'possible' });
  expect(operationOutcome(failed).nextActions).toEqual(['verify-outcome']);
  expect(operationOutcome({ ...failed, requiresUserAction: true }).nextActions).toEqual(['user-decision']);
});
it('passes through attested orthogonal facts instead of re-deriving them', () => {
  expect(operationOutcome(result({ handoff: 'handed-off', businessStart: 'started', liveness: 'exited' })))
    .toMatchObject({ receipt: 'done', handoff: 'handed-off', businessStart: 'started', liveness: 'exited' });
});
it('treats an attested not-sent failed dispatch as rejected even without other markers', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: undefined, handoff: 'not-sent' })))
    .toMatchObject({ receipt: 'rejected', handoff: 'not-sent' });
});
it('treats an attested running process as a running receipt', () => {
  expect(operationOutcome(result({ status: 'unknown', liveness: 'running' }))).toMatchObject({ receipt: 'running', liveness: 'running' });
});
it('offers a reviewed alternative only for a transport-proven pre-payload capability failure', () => {
  const failed = result({ status: 'failed', exitCode: 127, effects: 'none', privilege: { method: 'sudo', code: 'sudo-unavailable',
    stage: 'preparation', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } });
  expect(operationOutcome(failed)).toMatchObject({ receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started', nextActions: ['confirm-alternative'] });
  expect(canOfferSuFallback({ ...failed, requiresUserAction: true })).toBe(false);
  expect(canOfferSuFallback({ ...failed, authentication: 'failed' })).toBe(false);
  expect(operationOutcome({ ...failed, privilege: { ...failed.privilege!, source: 'output-inference' } })).toMatchObject({ receipt: 'done', handoff: 'unknown', nextActions: ['inspect-result'] });
});
it('distinguishes a host lock preventing dispatch from the prior unknown outcome', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: undefined, effects: 'none', failureKind: 'unresolved-prior-operation' })))
    .toMatchObject({ receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started', nextActions: ['verify-outcome'] });
});
it('marks a correctable dispatch-boundary failure as rejected and revisable', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: undefined, effects: 'none', failureKind: 'not-dispatched' })))
    .toMatchObject({ receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started', nextActions: ['revise-operation'] });
});
it('never turns arbitrary output into a no-dispatch assertion', () => {
  expect(operationOutcome(result({ status: 'failed', exitCode: 1, effects: 'possible', stdoutTail: 'sudo: user not in sudoers; not-started=true' })))
    .toMatchObject({ receipt: 'done', handoff: 'unknown', effects: 'possible', nextActions: ['verify-outcome'] });
});
it('appends log reading only to follow-ups that need the record', () => {
  expect(operationOutcome(result({ status: 'unknown', logRef: 'terminal' })).nextActions).toEqual(['verify-outcome', 'read-log']);
  expect(operationOutcome(result({ status: 'failed', exitCode: 1, effects: 'none', logRef: 'terminal' })).nextActions).toEqual(['inspect-result', 'read-log']);
  expect(operationOutcome(result({ logRef: 'terminal' })).nextActions).toEqual(['continue']);
});
it('keeps denied/stale operations distinct from correctable syntax and protected replays', () => {
  expect(notStartedOutcome('human-denied')).toMatchObject({ version: 2, receipt: 'rejected', handoff: 'not-sent',
    businessStart: 'not-started', liveness: 'unknown', exit: null, effects: 'none', nextActions: ['user-decision'], replay: 'never' });
  expect(notStartedOutcome('authorization-expired').nextActions).toEqual(['user-decision']);
  expect(notStartedOutcome('unsupported-root-command').nextActions).toEqual(['revise-operation']);
  expect(notStartedOutcome('replay-protected').nextActions).toEqual(['inspect-result']);
});
