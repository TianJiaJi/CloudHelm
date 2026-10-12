import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot, OperationView } from '@cloudhelm/contracts';
import { RecoveryCard } from './recovery-card.js';

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
  expect(markup).toContain('请点击对话顶部的「继续 AI」或发送消息');
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

it('does not treat a completed read-only query or proposed command as a new lock event', () => {
  const data = snapshot([original, { ...blocked, id: 'read', readOnly: true, status: 'succeeded', failureKind: undefined }]);
  expect(render(data)).toBe('');
  data.operations.push({ ...blocked, id: 'proposed', status: 'proposed', failureKind: undefined });
  expect(render(data)).toBe('');
});
