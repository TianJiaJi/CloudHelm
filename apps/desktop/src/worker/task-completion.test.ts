import { describe, expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { decideTaskCompletion, reportRequiredOperations } from './task-completion.js';

const query: OperationView = { id: 'query', taskId: 'task', hostId: 'host', kind: 'command',
  preview: 'docker images', readOnly: true, status: 'succeeded', exitCode: 0, createdAt: 1 };
const change: OperationView = { ...query, id: 'change', preview: 'touch /tmp/file', readOnly: false };
function complete(operations: OperationView[], roundOperations = operations, answered = true, hasReport = false) {
  return decideTaskCompletion({ operations, roundOperations, answered, hasReport });
}

describe('task completion independent of prose and command spelling', () => {
  it.each(['succeeded', 'failed'] as const)('finishes a %s query without report work', (status) => {
    expect(complete([{ ...query, status, effects: 'possible' }])).toEqual({ status: 'answered', verificationState: null });
  });
  it('uses the latest authoritative snapshot rather than a stale duplicate', () => {
    expect(complete([{ ...change, status: 'unknown' }, { ...change, readOnly: true }]))
      .toEqual({ status: 'answered', verificationState: null });
    expect(reportRequiredOperations([change, { ...change }])).toHaveLength(1);
  });
  it('finishes a conceptual answer without proposing any operation', () => {
    expect(complete([])).toEqual({ status: 'answered', verificationState: null });
  });
  it('does not reuse an earlier answer for an incomplete current turn', () => {
    expect(complete([query], [query], false)).toMatchObject({ status: 'failed', resumeReason: 'model' });
  });
  it.each(['proposed', 'approved', 'running', 'unknown', 'failed'] as const)('requires resolution of a %s non-query', (status) => {
    expect(complete([{ ...change, status, effects: 'possible' }])).toMatchObject({ status: 'paused', resumeReason: 'verify' });
  });
  it('keeps an old unresolved write binding even outside the current report round', () => {
    expect(complete([{ ...change, status: 'unknown' }, query], [query])).toMatchObject({ status: 'paused', resumeReason: 'verify' });
  });
  it('does not require verification of a write that was never dispatched', () => {
    expect(complete([{ ...change, status: 'failed', effects: 'none' }, query])).toMatchObject({ status: 'answered', verificationState: null });
  });
  it('does not turn accepted risk into observed success or a new report requirement', () => {
    const accepted = { ...change, status: 'failed' as const, effects: 'possible' as const, reconciledAt: 10,
      reconciliation: { kind: 'risk-accepted' as const, explanation: 'user accepted uncertainty', at: 10 } };
    expect(complete([accepted, query])).toMatchObject({ status: 'answered', verificationState: null });
    expect(accepted.status).toBe('failed');
  });
  it('keeps unclassified successful operations conservative without claiming confirmed mutation', () => {
    const unclassified = { ...change, readOnly: undefined };
    expect(reportRequiredOperations([query, unclassified])).toEqual([unclassified]);
    expect(complete([query, unclassified])).toMatchObject({ status: 'answered', resumeReason: 'report',
      verificationState: { status: 'unverified', operationIds: ['change'], reasonCode: 'report-missing' } });
    expect(complete([unclassified]).summary).not.toContain('已发生变更');
  });
  it('finishes a report only for the current round and preserves its operation IDs', () => {
    expect(complete([query, change], [change], true, true)).toMatchObject({ status: 'answered',
      verificationState: { status: 'verified', operationIds: ['change'] } });
    expect(complete([change, query], [query])).toEqual({ status: 'answered', verificationState: null });
  });
  it.each(['checks-failed', 'checks-inconclusive', 'changes-unverified'] as const)('ends honestly with %s without claiming verified or demanding report replay', (reason) => {
    const completion = decideTaskCompletion({ operations: [change, query], roundOperations: [change, query], answered: true,
      hasReport: true, reportStatus: 'unverified', reportUnverifiedReason: reason });
    expect(completion).toMatchObject({ status: 'answered', verificationState: { status: 'unverified', reasonCode: reason } });
    expect(completion.resumeReason).toBeUndefined();
    expect(completion.summary).toContain('不会为凑通过');
  });
  it('returns actionable report feedback without changing its verification requirements', () => {
    expect(decideTaskCompletion({ operations: [change], roundOperations: [change], answered: true, hasReport: false,
      reportIssue: { code: 'verification-evidence-invalid', guidance: 'Use existing observation check-1.' } }))
      .toMatchObject({ status: 'answered', resumeReason: 'report', summary: expect.stringContaining('check-1') });
  });
});
