import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { triangleOutput, userWorkflow } from './verification-user-workflow-fixture.js';
import { buildVerificationReport } from '../../../apps/desktop/src/worker/verification-facts.js';
import { decideTaskCompletion } from '../../../apps/desktop/src/worker/task-completion.js';

const report = (operations: OperationView[]) => buildVerificationReport({ roundId: 'round', revision: 1, operations, all: operations });

it('automatically records the actual seven-step workflow, retaining the failed attempt without treating it as the final result', async () => {
  const operations = await userWorkflow(); const value = report(operations);
  expect(value.facts).toMatchObject({ execution: 'succeeded-after-retry', recoveredAttemptIds: ['not-started'], goals: 'execution-observed' });
  expect(value.goalChecks).toContainEqual(expect.objectContaining({ kind: 'run-completion', status: 'passed', operationIds: ['run'],
    observed: expect.stringContaining(triangleOutput) }));
  expect(value.goalChecks?.some((check) => check.kind === 'file-content')).toBe(false); // ls is not content read-back.
  expect(operations[3]?.status).toBe('failed'); expect(operations).toHaveLength(7);
});
it('compares an execution-time expectation without any report submission', async () => {
  const operations = await userWorkflow(); operations[4]!.outputExpectation = { expectedOutput: triangleOutput };
  expect(report(operations).facts?.goals).toBe('passed');
  expect(report(operations).goalChecks?.[0]).toMatchObject({ kind: 'run-output', expectationSource: 'before-execution', status: 'passed' });
  operations[4]!.outputExpectation = { expectedOutput: 'different output' };
  expect(report(operations).facts?.goals).toBe('failed');
});
it('does not hide a real script failure merely because a later command succeeded', async () => {
  const operations = await userWorkflow();
  operations[3] = { ...operations[3]!, failureKind: undefined, exitCode: 127, effects: 'none' };
  expect(report(operations).facts?.execution).toBe('failed');
});
it('does not declare an unstarted operation recovered without a later successful run of the same program', async () => {
  const operations = await userWorkflow(); operations.splice(4, 1);
  expect(report(operations).facts?.execution).not.toBe('succeeded-after-retry');
  expect(report(operations).facts?.execution).not.toBe('succeeded');
});
it('does not recover across hosts, program identities or observations older than the failed attempt', async () => {
  for (const mode of ['host', 'identity', 'time']) {
    const operations = await userWorkflow();
    if (mode === 'host') operations[4]!.hostId = 'other';
    if (mode === 'time') operations[4]!.createdAt = 0;
    if (mode === 'identity') operations[4]!.verificationSource = { kind: 'program-run', path: '/root/test/test.py', identity: 'different' };
    expect(report(operations).facts?.execution).toBe('failed');
  }
});
it('keeps a possibly partial launch failure blocked even when a later successful observation exists', async () => {
  const operations = await userWorkflow(); operations[3]!.effects = 'possible';
  expect(report(operations).facts?.recoveredAttemptIds).toEqual([]);
  expect(decideTaskCompletion({ operations, roundOperations: operations, answered: true, hasReport: true })).toMatchObject({ status: 'paused', resumeReason: 'verify' });
});
it('keeps unknown remote outcomes blocked independently of successful output observations', async () => {
  const operations = await userWorkflow(); operations[2] = { ...operations[2]!, status: 'unknown', exitObserved: false };
  const value = report(operations);
  expect(value.facts?.unresolvedOperationIds).toContain('install');
  expect(decideTaskCompletion({ operations, roundOperations: operations, answered: true, hasReport: true })).toMatchObject({ status: 'paused', resumeReason: 'verify' });
});
