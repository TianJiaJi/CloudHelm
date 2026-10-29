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
    window.fixture.reportUIV2Report = structuredClone(current.report);
    window.fixture.reportUISnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.getByRole('button', { name: /检查项展示回归/u }).click();
  const panel = page.locator('aside[class*="agentPanel"]');
  await panel.getByText('已登记 · 有未验证项', { exact: true }).waitFor();
  for (const text of ['历史模型判断：通过 · 文件状态', '历史模型判断：失败 · 应用健康', '历史模型判断：无法确定 · 外部入口']) await panel.getByText(text, { exact: true }).waitFor();
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
  assert.equal(await panel.getByText('历史模型判断：失败 · 应用健康', { exact: true }).count(), 0);
  await checkVerificationV3(page, panel, screenshot);
  await page.emulateMedia({ colorScheme: 'dark' }); await page.reload();
}

async function checkVerificationV3(page, panel, screenshot) {
  await page.evaluate(() => {
    const snapshot = window.fixture.reportUISnapshot; const task = snapshot.conversations[0];
    task.verificationHistory = [structuredClone(window.fixture.reportUIV2Report)];
    task.verificationRound = { version: 1, id: 'ui-round', closed: true, operationIds: ['write', 'not-started', 'run'] };
    task.report = { version: 3, summary: '已记录实际运行；业务要求未独立比较', access: [], changes: ['暂存文件并运行'], recovery: [],
      evidenceOperationIds: ['run'], goalChecks: [{ kind: 'run-completion', authority: 'deterministic', target: '脚本运行',
        operationIds: ['run'], expected: '实际结束并取得完整输出', observed: '退出码0，输出已完整记录', status: 'passed' }],
      facts: { roundId: 'ui-round', revision: 1, registration: 'automatic', execution: 'succeeded-after-retry', goals: 'execution-observed',
        impact: 'not-assessed', recoveredAttemptIds: ['not-started'], riskOperationIds: [], unresolvedOperationIds: [], uncheckedOperationIds: ['write'],
        operations: [{ operationId: 'write', hostId: 'fixture', kind: 'write-file', status: 'succeeded' },
          { operationId: 'not-started', hostId: 'fixture', kind: 'command', status: 'failed', exitCode: 127 },
          { operationId: 'run', hostId: 'fixture', kind: 'command', status: 'succeeded', exitCode: 0 }] } };
    window.fixture.rebuildInvocations = [];
    window.fixture.originalRebuild = window.cloudhelm.rebuildVerificationReport;
    window.cloudhelm.rebuildVerificationReport = async (id) => {
      window.fixture.rebuildInvocations.push(id);
      await new Promise((resolve) => { window.fixture.finishRebuild = resolve; });
    };
    window.fixture.callsBeforeRebuild = window.fixture.calls.length;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  for (const text of ['后端自动整理', '执行完成；未启动的尝试之后已有成功运行',
    '运行检查通过，输出已记录；业务输出要求未独立比较', '影响未独立评估，不否定已通过的目标检查', '执行观察：通过 · 脚本运行',
    '本报告没有文件内容读回证据；ls 只能说明目录项，不能证明内容已核对。']) await panel.getByText(text, { exact: true }).waitFor();
  await panel.getByRole('button', { name: '查看完整记录', exact: true }).click();
  const details = page.locator('section[class*="reportPage"]');
  await details.getByText('此前报告与修订（最近 1 份）', { exact: true }).click();
  await details.getByText('历史模型判断：失败 · 应用健康', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '仅按已有记录重新整理', exact: true }).click();
  const pending = panel.getByRole('button', { name: '正在整理已有记录…', exact: true });
  await pending.waitFor(); assert.equal(await pending.isDisabled(), true);
  await pending.evaluate((element) => element.click());
  assert.equal(await page.evaluate(() => window.fixture.rebuildInvocations.length), 1, 'Duplicate clicks must not issue another rebuild');
  assert.equal(await page.evaluate(() => window.fixture.calls.length === window.fixture.callsBeforeRebuild), true,
    'Rebuilding a report must not start/send/resume a conversation');
  await page.evaluate(() => window.fixture.finishRebuild());
  const ready = panel.getByRole('button', { name: '仅按已有记录重新整理', exact: true });
  await ready.waitFor(); assert.equal(await ready.isEnabled(), true);
  await page.evaluate(() => { window.cloudhelm.rebuildVerificationReport = window.fixture.originalRebuild; });
  await page.emulateMedia({ colorScheme: 'dark' }); await screenshot('verification-v3-dark.png');
  await page.emulateMedia({ colorScheme: 'light' }); await screenshot('verification-v3-light.png');
}
