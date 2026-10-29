import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { TaskView } from '@cloudhelm/contracts';
import { VerificationCard } from '../../../apps/desktop/src/renderer/workspace-pages.js';

const task = (status: 'verified' | 'unverified'): TaskView => ({
  id: 'task', goal: '创建文件', hostIds: ['host'], localScopes: [], modelId: 'fixture',
  status: 'answered', requestCount: 2, requestLimit: 10, createdAt: 1, updatedAt: 2,
  verificationState: { status, operationIds: ['write'], ...status === 'unverified' ? { reasonCode: 'report-missing' as const } : {} },
  ...(status === 'verified' ? { report: { summary: '已读回验证', access: ['无'], changes: ['写入文件'],
    recovery: ['删除文件'], evidenceOperationIds: ['check'] } } : {})
});

it('distinguishes answered but unverified changes from a verified report', () => {
  const warning = renderToStaticMarkup(createElement(VerificationCard, { conversation: task('unverified'), report: () => {} }));
  expect(warning).toContain('已执行 · 未核验');
  expect(warning).toContain('不能仅凭退出码断言目标已完成');
  expect(warning).toContain('role="alert"');
  expect(warning).not.toContain('已读回验证');
  const verified = renderToStaticMarkup(createElement(VerificationCard, { conversation: task('verified'), report: () => {} }));
  expect(verified).toContain('已读回验证');
  expect(verified).not.toContain('已执行 · 未核验');
});
