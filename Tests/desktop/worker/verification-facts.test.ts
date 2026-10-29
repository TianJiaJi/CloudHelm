import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { buildVerificationReport, evaluateRunOutput, verificationReason } from '../../../apps/desktop/src/worker/verification-facts.js';
import { validateSubmissionV3 } from '../../../apps/desktop/src/worker/verification-submission.js';
import { WorkJournal } from '../../../apps/desktop/src/worker/work-journal.js';
import type { BusinessTool } from '@cloudhelm/core';

const run = (output = '*\n**\n***\n', patch: Partial<OperationView> = {}): OperationView => ({ id: 'run', taskId: 'task', hostId: 'host',
  kind: 'command', preview: 'python3 test.py', createdAt: 2, status: 'succeeded', readOnly: false, effects: 'possible', exitCode: 0,
  exitObserved: true, completedAt: 2, outputTail: output, outputCapture: { totalChars: output.length, tailChars: output.length, truncated: false }, ...patch });
const assertion = { kind: 'run-output' as const, operationId: 'run', expectedOutput: '*\n**\n***\n' };
const build = (operations: OperationView[], all = operations) => buildVerificationReport({ roundId: 'round', revision: 1, operations, all });

it('verifies the actual triangle output independently of unassessed side effects', () => {
  const operation = run(); const check = evaluateRunOutput(operation, assertion);
  expect(check).toMatchObject({ status: 'passed', authority: 'deterministic' });
  const report = buildVerificationReport({ roundId: 'round', revision: 1, operations: [operation], all: [operation], checks: [check] });
  expect(report.facts).toMatchObject({ execution: 'succeeded', goals: 'passed', impact: 'not-assessed', uncheckedOperationIds: [] });
  expect(verificationReason(report)).toBeUndefined();
});
it('fails a wrong output even with exit zero; compares line endings but preserves whitespace', () => {
  expect(evaluateRunOutput(run('wrong\n'), assertion).status).toBe('failed');
  expect(evaluateRunOutput(run('*\r\n**\r\n***\r\n'), assertion).status).toBe('passed');
  expect(evaluateRunOutput(run('*\n**\n***'), assertion).status).toBe('failed');
});
it.each([
  { outputCapture: undefined }, { outputCapture: { totalChars: 100, tailChars: 9, truncated: true } },
  { exitObserved: false }, { status: 'unknown' as const },
  { reconciliation: { kind: 'evidence' as const, at: 3, outcome: 'succeeded' as const, explanation: 'inferred' } }
])('never upgrades incomplete output or inferred exit to deterministic pass: %j', (patch) => {
  expect(evaluateRunOutput(run(undefined, patch), assertion).status).toBe('inconclusive');
});
it('does not treat redacted replacement text as complete program output', () => {
  expect(evaluateRunOutput(run('[REDACTED LONG UNTERMINATED OUTPUT]\n'), assertion).status).toBe('inconclusive');
});
it('can fail on a genuinely observed wrong exit even when output is incomplete', () => {
  expect(evaluateRunOutput(run('', { status: 'failed', exitCode: 1, outputCapture: undefined }), assertion).status).toBe('failed');
});
it('automatically matches file read-back by host, exact path and written content hash, not stat or another file', () => {
  const content = 'print("hello")\n';
  const write: OperationView = { ...run(), id: 'write', kind: 'write-file', verificationSource: { kind: 'file-write', path: '/srv/test.py',
    sha256: createHash('sha256').update(content).digest('hex') } };
  const read = run(content, { id: 'read', readOnly: true, effects: 'none', verificationSource: { kind: 'file-read', path: '/srv/test.py' } });
  expect(build([write, read]).goalChecks).toEqual([expect.objectContaining({ kind: 'file-content', status: 'passed', operationIds: ['write', 'read'] })]);
  expect(build([write, { ...read, verificationSource: undefined, preview: 'stat /tmp/unrelated' }]).facts?.goals).toBe('not-checked');
  expect(build([write, { ...read, hostId: 'other' }]).facts?.goals).toBe('not-checked');
  expect(build([write, { ...read, verificationSource: { kind: 'file-read', path: '/tmp/other' } }]).facts?.goals).toBe('not-checked');
  expect(build([read, write]).facts?.goals).toBe('not-checked');
  expect(build([{ ...write, completedAt: 10 }, read]).facts?.goals).toBe('not-checked');
  expect(build([{ ...write, completedAt: undefined }, read]).facts?.goals).toBe('not-checked');
  const textWrite = { ...write, verificationSource: { ...write.verificationSource!, kind: 'file-write' as const, path: '/srv/test.py', sha256: '',
    textSha256: createHash('sha256').update(content).digest('hex') } };
  const crlf = content.replace(/\n/gu, '\r\n');
  const crlfRead = { ...read, outputTail: crlf, outputCapture: { totalChars: crlf.length, tailChars: crlf.length, truncated: false } };
  expect(build([textWrite, crlfRead]).goalChecks?.[0]?.status).toBe('passed');
  const wrong = run('bad', { ...read, outputTail: 'bad', outputCapture: { totalChars: 3, tailChars: 3, truncated: false } });
  expect(build([write, wrong]).goalChecks?.[0]?.status).toBe('failed');
});
it('retains accepted unknown risk, including from an earlier round, without pretending it succeeded', () => {
  const risk = run('', { id: 'old', status: 'unknown', reconciledAt: 4,
    reconciliation: { kind: 'risk-accepted', at: 4, explanation: 'user accepts uncertainty' } });
  const operation = run(); const report = buildVerificationReport({ roundId: 'round', revision: 1, operations: [operation], all: [risk, operation],
    checks: [evaluateRunOutput(operation, assertion)] });
  expect(report.facts).toMatchObject({ goals: 'passed', impact: 'risk-accepted', riskOperationIds: ['old'] });
  expect(verificationReason(report)).toBe('risk-accepted');
  expect(build([risk]).facts?.execution).toBe('unknown');
  const lateObservedSuccess = { ...risk, status: 'succeeded' as const, exitObserved: true };
  expect(build([lateObservedSuccess]).facts?.riskOperationIds).toEqual([]);
  expect(lateObservedSuccess.reconciliation?.kind).toBe('risk-accepted');
});
it('allows optional notes with backend coverage and labels semantic assertions as model judgments', () => {
  const observation = run('metadata', { readOnly: true, effects: 'none' });
  expect(validateSubmissionV3('task', { version: 3 }, [observation], [observation])).toMatchObject({ accepted: true });
  const value = { version: 3, checks: [{ kind: 'model-assessment', evidenceOperationId: 'run', target: 'config active',
    expected: 'active', observed: 'stat returned', status: 'passed' }] };
  const result = validateSubmissionV3('task', value, [observation], [observation]);
  expect(result).toMatchObject({ accepted: true, checks: [{ authority: 'model' }] });
  if (result.accepted) {
    const report = buildVerificationReport({ roundId: 'r', revision: 1, operations: [observation], all: [observation], checks: result.checks });
    expect(report.facts?.goals).toBe('model-assessed');
  }
  expect(validateSubmissionV3('task', value, [], [observation])).toMatchObject({ accepted: false });
});
it('never permits a report to clear an unresolved mutation or store credentials', () => {
  const unresolved = run('', { status: 'unknown' });
  expect(validateSubmissionV3('task', { version: 3 }, [unresolved], [unresolved])).toMatchObject({ accepted: false, code: 'verification-outcome-unresolved' });
  const rejected = validateSubmissionV3('task', { version: 3, summary: 'password=fixture-secret' }, [run()], [run()]);
  expect(rejected).toMatchObject({ accepted: false, code: 'verification-secret' });
  expect(JSON.stringify(rejected)).not.toContain('fixture-secret');
});
it('generates a base report without model notes, closes repeated repair and never executes remote work', async () => {
  const events: unknown[] = []; const journal = new WorkJournal('task', () => [run()], (event) => events.push(event), async () => { throw new Error('must not read logs'); });
  const tool = journal.tools().find((entry) => entry.name === 'submit_verification') as BusinessTool<unknown>;
  const bad = { version: 3, checks: [{ ...assertion, operationId: 'foreign' }] };
  expect((await tool.execute('bad', bad)).isError).toBe(true);
  expect((await tool.execute('retry', bad)).isError).toBe(true);
  expect((await tool.execute('stop', bad)).isError).toBe(false);
  expect(journal.submissionClosed()).toBe(true);
  expect(journal.finalize('round')?.facts).toMatchObject({ registration: 'automatic', execution: 'succeeded', goals: 'execution-observed' });
  expect(events).toHaveLength(1);
});
it('retains validated expectations across restart and re-evaluates changed backend observations', async () => {
  let operations = [run()];
  const journal = new WorkJournal('task', () => operations, () => {}, async () => ({ text: '', nextCursor: 0, more: false }),
    undefined, undefined, undefined, () => 'round');
  const tool = journal.tools().find((entry) => entry.name === 'submit_verification') as BusinessTool<unknown>;
  await tool.execute('notes', { version: 3, checks: [assertion] });
  const saved = journal.finalize('round')!;
  const restored = new WorkJournal('task', () => operations, () => {}, async () => ({ text: '', nextCursor: 0, more: false }),
    undefined, undefined, undefined, () => 'round', saved);
  expect(restored.finalize('round')?.facts?.goals).toBe('passed');
  operations = [run('changed\n')];
  expect(restored.finalize('round')?.facts?.goals).toBe('failed');
});
it('rejects a report that replaces a pre-execution expectation with observed wrong output', () => {
  const operation = run('wrong\n', { outputExpectation: { expectedOutput: assertion.expectedOutput } });
  const result = validateSubmissionV3('task', { version: 3, checks: [{ ...assertion, expectedOutput: 'wrong\n' }] }, [operation], [operation]);
  expect(result).toMatchObject({ accepted: false, code: 'verification-expectation-bound' });
});
it('does not copy credential-bearing preview URLs into automatic change descriptions', () => {
  const value = build([run(undefined, { preview: 'curl https://alice:fixture-private@example.test/data' })]);
  expect(JSON.stringify(value)).not.toContain('fixture-private');
  expect(value.changes[0]).toContain('疑似凭据');
});
it('does not let a second submission silently change expectations to manufacture a pass', async () => {
  const journal = new WorkJournal('task', () => [run('wrong\n')], () => {}, async () => ({ text: '', nextCursor: 0, more: false }));
  const tool = journal.tools().find((entry) => entry.name === 'submit_verification') as BusinessTool<unknown>;
  await tool.execute('first', { version: 3, checks: [assertion] });
  await tool.execute('rewrite', { version: 3, checks: [{ ...assertion, expectedOutput: 'wrong\n' }] });
  expect(journal.finalize('round')?.facts?.goals).toBe('failed');
});
