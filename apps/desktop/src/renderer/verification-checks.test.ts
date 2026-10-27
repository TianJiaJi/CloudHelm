import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { TaskView, VerificationReportV2 } from '@cloudhelm/contracts';
import { VerificationCard } from './workspace-pages.js';
import { VerificationChecks } from './verification-checks.js';
const value: VerificationReportV2 = { version: 2, summary: '配置写入，但健康检查失败', access: ['不适用'], evidenceOperationIds: ['check'],
  changes: ['配置写入'], recovery: ['保留备份'], checks: [{ changeOperationIds: ['write'], target: '应用健康', expected: '健康接口成功',
    observed: '接口检查未通过', evidenceOperationIds: ['check'], status: 'failed' }], unverifiedChanges: [] };
it('shows individual observed/expected/evidence fields without upgrading failures to passed', () => {
  const markup = renderToStaticMarkup(createElement(VerificationChecks, { value }));
  for (const text of ['失败', '应用健康', '健康接口成功', '接口检查未通过', 'write', 'check', '不自动证明']) expect(markup).toContain(text);
});
it('labels legacy reports without automatically granting new-format check conclusions', () => {
  const { version: _v, checks: _c, unverifiedChanges: _u, ...legacy } = value;
  expect(renderToStaticMarkup(createElement(VerificationChecks, { value: legacy }))).toContain('历史格式报告');
});
it('keeps an honest failed report unverified without a phantom continue-verification button', () => {
  const conversation: TaskView = { id: 'task', goal: '检查', hostIds: [], localScopes: [], status: 'answered', session: { version: 1, id: 'task' },
    modelId: 'fixture', requestCount: 1, requestLimit: 100, createdAt: 1, updatedAt: 1,
    report: value, verificationState: { status: 'unverified', reasonCode: 'checks-failed', operationIds: ['write'] } };
  const markup = renderToStaticMarkup(createElement(VerificationCard, { conversation, report() {} }));
  expect(markup).toContain('已登记 · 有未验证项'); expect(markup).toContain('接口检查未通过');
  expect(markup).not.toContain('>继续核验<'); expect(markup).not.toContain('>已核验<');
});
