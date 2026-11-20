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
it('keeps decisions available after a soft expiry inside the hard window', () => {
  const now = Date.now();
  const output = html({ ...approval, expiresAt: now - 1000, hardExpiresAt: now + 3_600_000, renewals: 0 });
  expect(output).toContain('已超时，请尽快决定或续期');
  expect(output).toContain('剩余续期 5/5 次');
  expect(output).toMatch(/最晚 \d{2}:\d{2} 截止/u);
  expect(output).not.toContain('请求已过期');
  expect(output).not.toContain('disabled');
});
it('keeps the legacy single-deadline card disabled after expiry', () => {
  const output = html({ ...approval, expiresAt: Date.now() - 1000 });
  expect(output).toContain('请求已过期');
  expect(output).toContain('disabled');
  expect(output).not.toContain('剩余续期');
});
