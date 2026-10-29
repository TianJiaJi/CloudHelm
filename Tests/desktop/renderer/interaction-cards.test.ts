import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ApprovalView } from '@cloudhelm/contracts';
import { ApprovalCard } from '../../../apps/desktop/src/renderer/interaction-cards.js';

const approval: ApprovalView = { id: 'approval', taskId: 'task', operationId: 'operation', hostId: 'host', fingerprint: 'fixture',
  title: '批准这次远程命令', explanation: '现有审批原因保持不变', preview: 'sudo -- cat /root/test/test.py',
  account: 'root', cwd: '/tmp', targets: ['/root/test/test.py'], impact: 'unknown', expiresAt: Date.now() + 60_000 };
const html = (value: ApprovalView) => renderToStaticMarkup(createElement(ApprovalCard, {
  approval: value, host: 'fixture', report: () => {}
})).replace(/<!--.*?-->/gu, '');

it('labels the execution directory separately from the absolute operation target', () => {
  const output = html(approval);
  expect(output).toContain('执行账号：root · 工作目录：/tmp');
  expect(output).toContain('操作目标：/root/test/test.py');
  expect(output).toContain('sudo -- cat /root/test/test.py');
  expect(output).not.toContain('工作目录：/root/test');
  expect(approval.cwd).toBe('/tmp');
});
it('preserves backend approval reasons and impact instead of changing their classification', () => {
  const output = html(approval);
  expect(output).toContain('现有审批原因保持不变');
  expect(output).toContain('影响：尚不明确');
});
it('does not invent a working directory or derive one from the target', () => {
  const output = html({ ...approval, cwd: undefined });
  expect(output).toContain('工作目录：未知');
  expect(output).toContain('操作目标：/root/test/test.py');
});
