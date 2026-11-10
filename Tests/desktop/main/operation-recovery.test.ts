import { expect, it } from 'vitest';
import type { OperationView, ExecutionJobView } from '@cloudhelm/contracts';
import { recoverOperation } from '../../../apps/desktop/src/main/operation-recovery.js';
const job: ExecutionJobView = { version: 1, jobId: 'job', operationId: 'op', taskId: 'task', hostId: 'host',
  terminalId: 'terminal', terminalGeneration: 1, connectionId: 'connection:1', loginAs: 'ubuntu', runAs: 'ubuntu',
  status: 'running', createdAt: 1, updatedAt: 2, processSequence: 1, pid: 42, exitObserved: false };
const operation: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'synthetic',
  status: 'running', createdAt: 1, executionJob: job };
it.each(['starting', 'running', 'stop-requested'] as const)('restores %s as unknown before any conversation/SSH resumes', (status) => {
  const value = { ...operation, executionJob: { ...job, status, stopRequestId: 'stop' } }, original = structuredClone(value);
  expect(recoverOperation(value, 'lost')).toMatchObject({ status: 'unknown',
    executionJob: { status: 'unknown', unknownReason: 'recovered', exitObserved: false, stopRequestId: 'stop' } });
  expect(value).toEqual(original);
});
it('preserves actual exit even if the last operation projection was still running', () => {
  expect(recoverOperation({ ...operation, executionJob: { ...job, status: 'failed', exitObserved: true, exitCode: 130, endedAt: 3 } }, 'lost'))
    .toMatchObject({ status: 'failed', exitObserved: true, exitCode: 130, executionJob: { status: 'failed', exitObserved: true } });
});
it('preserves actual operation exit when its job projection lagged', () => {
  expect(recoverOperation({ ...operation, status: 'succeeded', exitObserved: true, exitCode: 0, completedAt: 3 }, 'lost'))
    .toMatchObject({ status: 'succeeded', executionJob: { status: 'exited', exitObserved: true, exitCode: 0 } });
});
it('does not publish a foreign or malformed job as a control capability', () => {
  const recovered = recoverOperation({ ...operation, executionJob: { ...job, taskId: 'foreign' } }, 'lost');
  expect(recovered.status).toBe('unknown'); expect(recovered.executionJob).toBeUndefined();
});
