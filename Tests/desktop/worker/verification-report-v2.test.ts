import { expect, it } from 'vitest';
import type { OperationView, VerificationReportV2 } from '@cloudhelm/contracts';
import { validateVerificationV2 } from '../../../apps/desktop/src/worker/verification-report-v2.js';
import { WorkJournal } from '../../../apps/desktop/src/worker/work-journal.js';
import type { BusinessTool } from '@cloudhelm/core';
const change: OperationView = { id: 'write', taskId: 'task', hostId: 'host', kind: 'write-file', preview: 'write',
  status: 'succeeded', createdAt: 1, readOnly: false, exitCode: 0, effects: 'possible' };
const check: OperationView = { id: 'check', taskId: 'task', hostId: 'host', kind: 'command', preview: 'inspection',
  status: 'succeeded', createdAt: 2, readOnly: true, exitCode: 0, effects: 'none' };
function report(): VerificationReportV2 {
  return { version: 2, summary: '检查结论', access: ['不适用'], changes: ['写入配置'], recovery: ['保留私有备份'], evidenceOperationIds: ['check'],
    checks: [{ changeOperationIds: ['write'], target: '配置', expected: '内容符合目标', observed: '只读检查取得记录', evidenceOperationIds: ['check'], status: 'passed' }], unverifiedChanges: [] };
}
const validate = (value: unknown, ops = [change, check], all = ops) => validateVerificationV2('task', value, ops, all);
it('records structurally passed checks with full bindings, independently of report prose', () => {
  const value = report(); const accepted = validate(value); expect(accepted).toMatchObject({ accepted: true, reason: undefined });
  value.checks[0]!.observed = 'mutated after validation';
  if (accepted.accepted) expect(accepted.report.checks[0]?.observed).not.toBe('mutated after validation');
});
it.each(['failed', 'inconclusive'] as const)('accepts an honest %s check without turning it into verified or rerunning changes', (status) => {
  const value = report(); value.checks[0]!.status = status;
  expect(validate(value, [change, { ...check, status: 'failed', exitCode: 1 }])).toMatchObject({ accepted: true, reason: `checks-${status}` });
});
it('permits missing evidence only with an inconclusive observation or an explicit per-change reason', () => {
  const value = report(); value.evidenceOperationIds = []; value.checks[0]!.evidenceOperationIds = [];
  expect(validate(value)).toMatchObject({ accepted: false });
  value.checks[0]!.status = 'failed'; expect(validate(value)).toMatchObject({ accepted: false });
  value.checks[0]!.status = 'inconclusive'; value.checks[0]!.observed = '检查条件不可用，未取得证据';
  expect(validate(value)).toMatchObject({ accepted: true, reason: 'checks-inconclusive' });
  value.checks = []; value.unverifiedChanges = [{ operationId: 'write', reason: '需要用户授权外部检查，未执行' }];
  expect(validate(value)).toMatchObject({ accepted: true, reason: 'changes-unverified' });
});
it.each([
  { status: 'failed', exitCode: 1 }, { status: 'unknown' }, { status: 'running' }, { readOnly: false },
  { effects: 'possible' }, { exitCode: undefined }, { taskId: 'foreign' }, { hostId: 'foreign' },
  { reconciliation: { kind: 'risk-accepted', at: 3, explanation: 'accepted' } }
] as Array<Partial<OperationView>>)('rejects invalid passed evidence metadata %j', (patch) => {
  expect(validate(report(), [change, { ...check, ...patch }])).toMatchObject({ accepted: false });
});
it('requires same-host temporal coverage after the last change and preserves supplementary earlier checks', () => {
  expect(validate(report(), [check, change])).toMatchObject({ accepted: false });
  const cleanup = { ...change, id: 'cleanup', createdAt: 3 }; const final = { ...check, id: 'final', createdAt: 4 };
  const value = report(); value.checks.push({ ...value.checks[0]!, changeOperationIds: ['cleanup'], evidenceOperationIds: ['final'] });
  value.evidenceOperationIds.push('final');
  expect(validate(value, [change, check, cleanup, final])).toMatchObject({ accepted: true, reason: undefined });
  value.checks[1]!.evidenceOperationIds = ['check']; value.evidenceOperationIds = ['check'];
  expect(validate(value, [change, check, cleanup, final])).toMatchObject({ accepted: false });
});
it('requires every backend change covered and rejects duplicate/unknown/extra index IDs', () => {
  const value = report(); const second = { ...change, id: 'second' };
  expect(validate(value, [change, second, check])).toMatchObject({ accepted: false, code: 'verification-changes-uncovered' });
  value.evidenceOperationIds.push('unknown'); expect(validate(value)).toMatchObject({ accepted: false });
  value.evidenceOperationIds = ['check']; value.checks[0]!.changeOperationIds = ['unknown']; expect(validate(value)).toMatchObject({ accepted: false });
});
it('never clears another unresolved outcome, even with an inconclusive report', () => {
  const value = report(); value.checks[0]!.status = 'inconclusive';
  expect(validate(value, [change, check], [change, check, { ...change, id: 'pending', status: 'unknown' }]))
    .toMatchObject({ accepted: false, code: 'verification-outcome-unresolved' });
});
it('rejects oversized or secret-bearing observations and unknown fields without echoing them', () => {
  const value = report(); value.checks[0]!.observed = 'token=fixture-private-secret';
  const rejected = validate(value); expect(rejected).toMatchObject({ accepted: false, code: 'verification-secret' });
  expect(JSON.stringify(rejected)).not.toContain('fixture-private-secret');
  value.checks[0]!.observed = 'x'.repeat(2049); expect(validate(value)).toMatchObject({ accepted: false });
  expect(validate({ ...report(), undocumented: 'ignored?' })).toMatchObject({ accepted: false });
  expect(validate({ ...report(), checks: Array.from({ length: 33 }, () => report().checks[0]) })).toMatchObject({ accepted: false });
});
it('keeps accepted failed reports unverified and refuses a legacy-format downgrade', async () => {
  const journal = new WorkJournal('task', () => [change, check], () => {}, async () => ({ text: '', nextCursor: 0, more: false }));
  const tool = journal.tools().find((tool) => tool.name === 'submit_verification') as BusinessTool<unknown>;
  const value = report(); value.checks[0]!.status = 'failed';
  expect((await tool.execute('report', value)).isError).toBe(false);
  expect(journal.hasReport()).toBe(true); expect(journal.completionReport()).toMatchObject({ reportStatus: 'unverified', reportUnverifiedReason: 'checks-failed' });
  const { version: _version, checks: _checks, unverifiedChanges: _unverified, ...legacy } = report();
  expect((await tool.execute('legacy', legacy)).isError).toBe(true);
  expect(journal.completionReport().reportStatus).toBe('unverified');
});
