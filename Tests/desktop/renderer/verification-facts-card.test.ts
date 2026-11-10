import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { TaskView, VerificationReport, VerificationFacts } from '@cloudhelm/contracts';
import { VerificationCard } from '../../../apps/desktop/src/renderer/workspace-pages.js';
import { VerificationHistory } from '../../../apps/desktop/src/renderer/verification-facts-card.js';
const report = (patch: Partial<VerificationFacts> = {}): VerificationReport => ({ version: 3, summary: '仅说明已有观察', access: [], changes: [], recovery: [],
  evidenceOperationIds: ['run'], goalChecks: [{ kind: 'run-output', authority: 'deterministic', target: '本次运行输出', operationIds: ['run'],
    status: 'passed', expected: '*\n**\n***\n', observed: '*\n**\n***\n' }],
  facts: { roundId: 'round', revision: 1, registration: 'submitted', execution: 'succeeded', goals: 'passed', impact: 'not-assessed',
    operations: [{ operationId: 'run', hostId: 'host', status: 'succeeded', readOnly: false, exitCode: 0 }],
    riskOperationIds: [], unresolvedOperationIds: [], uncheckedOperationIds: [], ...patch } });
const task = (value: VerificationReport): TaskView => ({ id: 'task', goal: '运行三角形', hostIds: ['host'], localScopes: [], modelId: 'fixture',
  status: 'answered', requestCount: 3, requestLimit: 100, createdAt: 1, updatedAt: 2, report: value,
  verificationState: { status: 'unverified', operationIds: ['run'] },
  verificationRound: { version: 1, id: value.facts!.roundId, closed: true, operationIds: value.facts!.operations.map((op) => op.operationId) } });
const render = (value: VerificationReport) => renderToStaticMarkup(createElement(VerificationCard, { conversation: task(value), report() {} }));
it('shows passing output and unassessed impact separately without a blanket yellow failure or retry button', () => {
  const markup = render(report());
  expect(markup).toContain('执行证据'); expect(markup).toContain('操作记录（1）');
  expect(markup).toContain('规则比较：匹配'); expect(markup).toContain('预期：'); expect(markup).toContain('观察：');
  expect(markup).not.toContain('影响未独立评估'); expect(markup).not.toContain('仅确认下列具体观察');
  expect(markup).not.toContain('role="alert"'); expect(markup).not.toContain('有未验证项'); expect(markup).not.toContain('继续核验');
});
it('makes risk-accepted unknown outcomes persistently visible even when output checks pass', () => {
  const markup = render(report({ impact: 'risk-accepted', riskOperationIds: ['old-unknown'] }));
  expect(markup).toContain('已接管风险的操作'); expect(markup).toContain('原结果仍未知');
  expect(markup).toContain('old-unknown'); expect(markup).not.toContain('role="alert"');
});
it('labels model interpretation distinctly instead of suggesting backend proof', () => {
  const value = report({ goals: 'model-assessed' }); value.goalChecks![0]!.authority = 'model';
  expect(render(value)).toContain('模型判断：通过'); expect(render(value)).toContain('不是后端确定性证明');
});
it('shows automatic facts without notes as not checked, not a report-submission failure', () => {
  const value = report({ registration: 'automatic', goals: 'not-checked' }); value.goalChecks = [];
  const markup = render(value);
  expect(markup).toContain('操作记录（1）'); expect(markup).not.toContain('具体检查（');
  expect(markup).not.toContain('role="alert"'); expect(markup).not.toContain('继续核验');
});
it('preserves a specific mismatching observation without inventing an overall task verdict', () => {
  const value = report({ goals: 'failed' }); value.goalChecks![0]!.status = 'failed'; value.goalChecks![0]!.observed = 'different-output';
  const markup = render(value);
  expect(markup).toContain('规则比较：不匹配'); expect(markup).toContain('different-output');
  expect(markup).not.toContain('role="alert"'); expect(markup).not.toContain('有已登记的检查失败');
});
it('keeps unresolved operations explicitly identified in evidence', () => {
  const markup = render(report({ unresolvedOperationIds: ['unknown-operation'] }));
  expect(markup).toContain('role="alert"'); expect(markup).toContain('unknown-operation'); expect(markup).toContain('不要直接重试');
});
it('shows a recovered launch failure and real automatic run observations, not a blanket task failure or missing-report warning', () => {
  const value = report({ registration: 'automatic', execution: 'succeeded-after-retry', goals: 'execution-observed', recoveredAttemptIds: ['launch'],
    uncheckedOperationIds: ['stage', 'install', 'cleanup'], operations: [{ operationId: 'stage', hostId: 'host', kind: 'write-file', status: 'succeeded' }] });
  value.goalChecks![0]!.kind = 'run-completion';
  const markup = render(value);
  expect(markup).toContain('已恢复的早期尝试'); expect(markup).toContain('launch'); expect(markup).toContain('执行观察：通过');
  expect(markup).toContain('stage: 执行返回'); expect(markup).not.toContain('业务输出要求未独立比较');
  expect(markup).not.toContain('ls 只能说明目录项');
  expect(markup).toContain('仅按已有记录重新整理'); expect(markup).toContain('不运行命令、不调用模型');
  expect(markup).not.toContain('有操作失败或被拒绝'); expect(markup).not.toContain('尚未登记目标检查'); expect(markup).not.toContain('role="alert"');
});
it('keeps earlier uncertainty visible in report history', () => {
  const old = report({ goals: 'inconclusive', impact: 'risk-accepted', riskOperationIds: ['accepted-risk'] });
  old.goalChecks![0]!.status = 'inconclusive'; old.goalChecks![0]!.observed = 'missing-observation';
  const markup = renderToStaticMarkup(createElement(VerificationHistory, { values: [old] }));
  expect(markup).toContain('风险接管记录'); expect(markup).toContain('accepted-risk');
  expect(markup).toContain('规则比较：无法比较'); expect(markup).toContain('missing-observation');
});
