import { expect, it } from 'vitest';
import { Value } from 'typebox/value';
import type { BusinessTool } from '@cloudhelm/core';
import { VerificationSubmissionV3Schema, type AppEvent, type OperationView, type VerificationReportV2 } from '@cloudhelm/contracts';
import { validateVerificationV2 } from '../../../apps/desktop/src/worker/verification-report-v2.js';
import { WorkJournal } from '../../../apps/desktop/src/worker/work-journal.js';

const write: OperationView = { id: 'write', taskId: 'task', hostId: 'host', kind: 'write-file', preview: 'fixture',
  status: 'succeeded', readOnly: false, exitCode: 0, createdAt: 1 };
const script: OperationView = { ...write, id: 'script-run', kind: 'command', createdAt: 2 };
const cleanup = { ...write, id: 'cleanup', kind: 'delete-path' as const, createdAt: 3 };
const check: OperationView = { ...write, id: 'final-cat', kind: 'command', readOnly: true, effects: 'none', createdAt: 4 };
const operations = [write, script, cleanup, check];
const validReport = (): VerificationReportV2 => ({ version: 2, summary: '登记观察，不宣称所有检查通过',
  access: ['不适用'], changes: ['写入并执行测试脚本，清理暂存'], recovery: ['保留恢复副本'],
  checks: [{ changeOperationIds: ['write'], target: '文件', expected: '内容正确', observed: '只读检查返回内容',
    evidenceOperationIds: ['final-cat'], status: 'passed' }], evidenceOperationIds: ['final-cat'],
  unverifiedChanges: [{ operationId: 'script-run', reason: '运行结果仅为参考，未证明无副作用' }, { operationId: 'cleanup', reason: '未独立核验暂存路径' }] });
const journal = (events: AppEvent[] = []) => new WorkJournal('task', () => operations, (event) => events.push(event),
  async () => { throw new Error('No log read or remote call is needed to repair a report'); });

it('advertises the exact shared V3 schema without mandatory coverage or empty arrays', () => {
  const tool = journal().tools().find((tool) => tool.name === 'submit_verification')!;
  expect(tool.parameters).toEqual(VerificationSubmissionV3Schema);
  expect(Value.Check(VerificationSubmissionV3Schema, { version: 3 })).toBe(true);
  expect(Value.Check(VerificationSubmissionV3Schema, validReport())).toBe(false);
  expect(tool.description).toContain('Optional report notes');
  expect(tool.description).toContain('run-output');
});
it('reports missing fields, an opaque evidence ID and uncovered operations together', () => {
  const value = validReport();
  value.checks.push({ ...value.checks[0]!, evidenceOperationIds: ['script-run'], status: 'inconclusive' });
  value.evidenceOperationIds.push('script-run');
  const { unverifiedChanges: _unused, ...missing } = value;
  const result = validateVerificationV2('task', missing, operations, operations);
  expect(result).toMatchObject({ accepted: false, code: 'verification-fields-invalid', issues: expect.arrayContaining([
    expect.objectContaining({ path: '/unverifiedChanges' }),
    expect.objectContaining({ code: 'verification-evidence-invalid', path: '/checks/1/evidenceOperationIds/0', operationIds: ['script-run'] }),
    expect.objectContaining({ code: 'verification-changes-uncovered', operationIds: ['script-run', 'cleanup'] })
  ]), repair: { requiredChanges: { operationIds: ['write', 'script-run', 'cleanup'], omitted: 0 },
    uncoveredChanges: { operationIds: ['script-run', 'cleanup'] }, eligibleEvidence: { operationIds: ['final-cat'] },
    finalChecksByHost: [{ hostId: 'host', lastChangeOperationId: 'cleanup', operationIds: ['final-cat'] }] } });
  expect(missing.checks[1]!.evidenceOperationIds).toEqual(['script-run']);
});
it('allows one correction without replay, auto-filling success or clearing uncertainty', async () => {
  const events: AppEvent[] = [];
  const book = journal(events);
  const tool = book.tools().find((tool) => tool.name === 'submit_verification') as BusinessTool<unknown>;
  const value = validReport();
  value.unverifiedChanges = [];
  value.checks.push({ ...value.checks[0]!, status: 'inconclusive', evidenceOperationIds: ['script-run'] });
  value.evidenceOperationIds.push('script-run');
  const rejected = await tool.execute('first', value);
  expect(rejected.isError).toBe(true);
  const feedback = JSON.parse(rejected.content[0]!.text);
  expect(feedback.issues.map((issue: { code: string }) => issue.code))
    .toEqual(expect.arrayContaining(['verification-evidence-invalid', 'verification-changes-uncovered']));
  expect(events).toEqual([]);
  value.checks[1]!.evidenceOperationIds = [];
  value.evidenceOperationIds = ['final-cat'];
  value.unverifiedChanges = feedback.repair.uncoveredChanges.operationIds.map((operationId: string) => ({ operationId, reason: '如实记录核验限制，未取得额外证据' }));
  expect((await tool.execute('corrected', value)).isError).toBe(false);
  expect(book.completionReport()).toEqual({ reportStatus: 'unverified', reportUnverifiedReason: 'checks-inconclusive' });
  expect(events).toHaveLength(1);
});
it('identifies every blank field by a safe schema path', () => {
  const value = validReport(); value.summary = ' '; value.checks[0]!.observed = '\t'; value.unverifiedChanges[0]!.reason = ' ';
  const result = validateVerificationV2('task', value, operations, operations);
  expect(result).toMatchObject({ accepted: false, issues: expect.arrayContaining([
    expect.objectContaining({ path: '/summary' }), expect.objectContaining({ path: '/checks/0/observed' }),
    expect.objectContaining({ path: '/unverifiedChanges/0/reason' })
  ]) });
});
it('does not disclose foreign IDs, report text or unknown field names in feedback', () => {
  const value = validReport();
  value.checks[0]!.evidenceOperationIds = ['password=fixture-private-secret'];
  const result = validateVerificationV2('task', value, operations, [...operations, { ...check, id: 'foreign-secret-id', taskId: 'other' }]);
  expect(result.accepted).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/fixture-private-secret|foreign-secret-id/u);
  expect(JSON.stringify(validateVerificationV2('task', { ...value, 'token=private-field-name': 'private-value' }, operations, operations)))
    .not.toMatch(/private-field-name|private-value/u);
});
it('never recommends failed, opaque or another conversation observations as passed evidence', () => {
  const failed = { ...check, id: 'failed-check', status: 'failed' as const, exitCode: 1 };
  const foreign = { ...check, id: 'foreign', taskId: 'other' };
  const value = { ...validReport(), undocumented: 'invalid' };
  const result = validateVerificationV2('task', value, [...operations, failed, foreign], [...operations, failed, foreign]);
  if (result.accepted) throw new Error('Malformed reports must not be accepted');
  expect(result.repair?.eligibleEvidence.operationIds).toEqual(['final-cat', 'failed-check']);
  expect(result.repair?.eligiblePassedEvidence.operationIds).toEqual(['final-cat']);
});
it('caps serialized diagnostic bytes with explicit omissions, never accepting a truncated report', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...write, id: `change-${i}-${'界'.repeat(150)}` }));
  const result = validateVerificationV2('task', { ...validReport(), checks: [], unverifiedChanges: [], evidenceOperationIds: [] }, many, many);
  expect(result.accepted).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(24_576);
  if (!result.accepted) expect(result.repair!.requiredChanges.operationIds.length + result.repair!.requiredChanges.omitted).toBe(100);
});
it('bounds repair lists without silently treating omitted operations as covered', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...write, id: `change-${i}` }));
  const result = validateVerificationV2('task', { ...validReport(), checks: [], unverifiedChanges: [], evidenceOperationIds: [] }, many, many);
  expect(result.accepted).toBe(false);
  if (result.accepted) return;
  expect(result.repair?.requiredChanges.operationIds).toHaveLength(64);
  expect(result.repair?.requiredChanges.omitted).toBe(36);
  expect(result.repair?.uncoveredChanges.omitted).toBe(36);
});
