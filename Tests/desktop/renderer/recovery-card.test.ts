import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot, OperationView } from '@cloudhelm/contracts';
import { DiagnosisNotice, RecoveryCard } from '../../../apps/desktop/src/renderer/recovery-card.js';

const original: OperationView = { id: 'old', taskId: 'source', hostId: 'host', kind: 'command',
  preview: 'docker ps -a', status: 'failed', effects: 'possible', exitCode: 1, createdAt: 1 };
const blocked: OperationView = { id: 'blocked', taskId: 'new', hostId: 'host', kind: 'command',
  preview: 'mkdir -p /home/tian/test', status: 'failed', failureKind: 'unresolved-prior-operation', effects: 'none', createdAt: 2 };
const snapshot = (operations: OperationView[]): AppSnapshot => ({ operations: operations.map((item) => ({ ...item })),
  messages: [{ taskId: 'new', role: 'user', text: '创建 test 文件夹', createdAt: 1 }],
  conversations: [{ id: 'source', hostIds: ['host'], goal: '检查磁盘空间' },
    { id: 'new', hostIds: ['host'], goal: '运行检查' }] } as AppSnapshot);
const render = (data: AppSnapshot) => renderToStaticMarkup(createElement(RecoveryCard, { snapshot: data, hostId: 'host',
  conversation: data.conversations[1], report: () => undefined }));

it('shows a backend restriction separately from recovery receipts and makes no unlock promise', () => {
  const notice = (reason: Parameters<typeof DiagnosisNotice>[0]['reason'], running: boolean) =>
    renderToStaticMarkup(createElement(DiagnosisNotice, { reason, running }));
  expect(notice(undefined, true)).toBe('');
  expect(notice('user-denied', true)).toContain('有操作未获批准');
  expect(notice('outcome-unverified', true)).toContain('AI 可以继续核验，不能发起新写入');
  expect(notice('outcome-unverified', false)).toContain('仍须遵守未解除的写锁及审核');
});

it('projects a historical revision blocker from backend risk bindings after the current revision is blocked', () => {
  const data = snapshot([{ ...original, hostId: 'previous-profile' }, blocked]);
  data.conversations[0]!.hostIds = ['previous-profile'];
  Object.assign(data, { hostRiskBindings: [
    { hostId: 'previous-profile', riskDomainId: 'previous-profile' }, { hostId: 'host', riskDomainId: 'previous-profile' }
  ] });
  expect(render(data)).toContain('阻断项 old');
  expect(render(data)).toContain('知晓风险，仅解除这条写入阻断');
});

it('does not invent cross-profile associations when the backend gives no matching risk domain', () => {
  const data = snapshot([{ ...original, hostId: 'previous-profile' }, blocked]);
  expect(render(data)).toBe('');
  Object.assign(data, { hostRiskBindings: [
    { hostId: 'previous-profile', riskDomainId: 'previous-profile' }, { hostId: 'host', riskDomainId: 'different-domain' }
  ] });
  expect(render(data)).toBe('');
});

it('does not display other conversations’ records before this conversation hits a write lock', () => {
  const data = snapshot([original]);
  expect(render(data)).toBe('');
  expect(renderToStaticMarkup(createElement(RecoveryCard, { snapshot: data, hostId: 'host',
    report: () => undefined }))).toBe('');
});

it('shows the current blocked command, simple risk and refusal/acceptance without navigating away', () => {
  const markup = render(snapshot([original, blocked]));
  expect(markup).toContain('本次写入暂未发送');
  expect(markup).toContain('mkdir -p /home/tian/test');
  expect(markup).toContain('用途：创建 test 文件夹');
  expect(markup).toContain('风险：同一主机的历史对话');
  expect(markup).toContain('拒绝，保持阻断');
  expect(markup).toContain('知晓风险，仅解除这条写入阻断');
  expect(markup).toContain('接受风险并继续对话');
  expect(markup).toContain('选择「仅解除」不会续跑');
  expect(markup).not.toContain('切换到来源对话');
  expect(markup).not.toContain('风险接管说明');
});

it('shows just one blocker at a time and advances after the previous record is resolved', () => {
  const next = { ...original, id: 'next', preview: 'another unresolved command' };
  const data = snapshot([original, next, blocked]);
  expect(render(data)).toContain('待处理 1 / 2 项');
  expect(render(data)).toContain('阻断项 old');
  expect(render(data)).not.toContain('another unresolved command');
  data.operations[0]!.reconciledAt = 10;
  expect(render(data)).toContain('待处理 1 / 1 项');
  expect(render(data)).toContain('阻断项 next');
  expect(render(data)).not.toContain('阻断项 old');
  data.operations[1]!.reconciledAt = 11;
  expect(render(data)).toBe('');
});

it('shows evidence reconciliation after the active card disappears, without claiming writes resumed', () => {
  const resolved: OperationView = { ...original, taskId: 'new', status: 'succeeded', reconciledAt: 10,
    reconciliation: { kind: 'evidence', outcome: 'succeeded', explanation: 'fixture observation', at: 10 } };
  const markup = render(snapshot([resolved]));
  expect(markup).toContain('原操作已按证据核验');
  expect(markup).toContain('不代表本轮恢复写入');
  expect(markup).not.toContain('接受风险并继续对话');
  expect(render(snapshot([{ ...resolved, taskId: 'source' }, blocked]))).toBe('');
});

it('shows a correlated acceptance and its backend continuation note alongside another blocker', () => {
  const accepted: OperationView = { ...original, reconciledAt: 10,
    reconciliation: { kind: 'risk-accepted', explanation: 'fixture acceptance', at: 10, sourceTaskId: 'new' },
    recoveryDecision: { version: 1, actionId: 'acceptance', action: 'accept-and-continue', at: 10, sourceTaskId: 'new',
      released: true, resumed: false, resumeNote: '同风险域仍有其他待核验操作' } };
  const markup = render(snapshot([accepted, { ...original, id: 'next' }, blocked]));
  expect(markup).toContain('已记录风险接管');
  expect(markup).toContain('未自动续跑：同风险域仍有其他待核验操作');
  expect(markup).toContain('阻断项 next');
  expect(render(snapshot([{ ...accepted, recoveryDecision: { ...accepted.recoveryDecision!, error: '写锁同步状态未确认' } }])))
    .toContain('写锁同步状态未确认');
});

it('does not treat a completed read-only query or proposed command as a new lock event', () => {
  const data = snapshot([original, { ...blocked, id: 'read', readOnly: true, status: 'succeeded', failureKind: undefined }]);
  expect(render(data)).toBe('');
  data.operations.push({ ...blocked, id: 'proposed', status: 'proposed', failureKind: undefined });
  expect(render(data)).toBe('');
});
