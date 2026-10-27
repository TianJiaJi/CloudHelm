/* global window, structuredClone */
import assert from 'node:assert/strict';

export async function checkVerificationChecks(page, screenshot) {
  await page.reload();
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  await page.evaluate(async () => {
    const task = await window.cloudhelm.startConversation({ hostId: null, message: '检查项展示回归',
      model: { provider: 'openai', modelId: 'gpt-5.4' }, localSelectionTokens: [] });
    const snapshot = await window.cloudhelm.snapshot(); const current = snapshot.conversations.find((item) => item.id === task.id);
    current.status = 'answered'; current.resumeReason = undefined;
    current.report = { version: 2, summary: '配置已登记，但检查未全部通过', access: ['不适用'], evidenceOperationIds: ['check-file', 'check-health'],
      changes: ['配置写入', '另一项变更未验证'], recovery: ['保留原始备份'], checks: [
        { changeOperationIds: ['write'], target: '文件状态', expected: '文件存在', observed: '只读stat成功', evidenceOperationIds: ['check-file'], status: 'passed' },
        { changeOperationIds: ['write'], target: '应用健康', expected: '健康接口成功', observed: 'HTTP 503', evidenceOperationIds: ['check-health'], status: 'failed' },
        { changeOperationIds: ['write'], target: '外部入口', expected: '外部可访问', observed: '未授权，未探测', evidenceOperationIds: [], status: 'inconclusive' }
      ], unverifiedChanges: [{ operationId: 'other-write', reason: '需要私有环境中的人工检查，尚未进行' }] };
    current.verificationState = { status: 'unverified', reasonCode: 'checks-failed', operationIds: ['write', 'other-write'] };
    snapshot.execution = { [task.id]: { model: 'idle', remote: 'idle', stopping: false, canStop: false } };
    window.fixture.reportUISnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.getByRole('button', { name: /检查项展示回归/u }).click();
  const panel = page.locator('aside[class*="agentPanel"]');
  await panel.getByText('已登记 · 有未验证项', { exact: true }).waitFor();
  for (const text of ['通过 · 文件状态', '失败 · 应用健康', '无法确定 · 外部入口']) await panel.getByText(text, { exact: true }).waitFor();
  await panel.getByText('观察：HTTP 503', { exact: true }).waitFor();
  await panel.getByText(/other-write：需要私有环境中的人工检查/u).waitFor();
  assert.equal(await panel.getByRole('button', { name: '继续核验', exact: true }).count(), 0, 'An honest unverified report must not create an automatic continuation');
  await screenshot('verification-checks-dark.png');
  await page.emulateMedia({ colorScheme: 'light' }); await screenshot('verification-checks-light.png');
  await page.evaluate(() => {
    const snapshot = window.fixture.reportUISnapshot; const report = snapshot.conversations[0].report;
    delete report.version; delete report.checks; delete report.unverifiedChanges;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await panel.getByText('历史格式报告：未包含逐项检查，不自动赋予新版检查结论。', { exact: true }).waitFor();
  assert.equal(await panel.getByText('失败 · 应用健康', { exact: true }).count(), 0);
  await page.emulateMedia({ colorScheme: 'dark' }); await page.reload();
}
