/* global window, structuredClone */
import assert from 'node:assert/strict';

export async function checkRequestBudget(page, screenshot) {
  await page.reload();
  const editor = page.getByRole('textbox', { name: '给 AI 的消息' });
  await editor.waitFor(); await editor.fill('预算按钮本地测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.kind === 'start'));
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot(); const task = snapshot.conversations[0];
    task.status = 'paused'; task.resumeReason = 'budget-exhausted';
    task.budget = { version: 1, roundId: 'ui-round', budgetRevision: 100, roundUsed: 100, roundLimit: 100,
      defaultRoundLimit: 100, totalUsed: 300, closed: false, origin: 'explicit' };
    snapshot.execution = { [task.id]: { model: 'running', remote: 'idle', stopping: false, canStop: false } };
    window.fixture.budgetSnapshot = snapshot;
    window.fixture.budgetCalls = []; window.fixture.separateResumes = 0;
    window.cloudhelm.resumeConversation = async () => { window.fixture.separateResumes++; };
    window.cloudhelm.extendRequestBudget = (input) => {
      window.fixture.budgetCalls.push(structuredClone(input));
      return new Promise((resolve, reject) => { window.fixture.budgetResolve = resolve; window.fixture.budgetReject = reject; });
    };
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const button = page.getByRole('button', { name: '追加100次并继续', exact: true });
  await button.waitFor(); assert.equal(await button.isDisabled(), true);
  await page.evaluate(() => {
    const snapshot = window.fixture.budgetSnapshot;
    snapshot.execution[snapshot.conversations[0].id].model = 'idle';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.waitForFunction(() => [...window.document.querySelectorAll('button')].some((item) => item.textContent === '追加100次并继续' && !item.disabled));
  await button.evaluate((element) => { element.click(); element.click(); });
  await page.getByRole('button', { name: '正在确认额度…' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.budgetCalls.length), 1);
  await page.getByText('本轮请求 100/100 · 累计 300', { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.budgetReject(new Error('预算确认未返回')));
  await page.getByRole('alertdialog').waitFor(); await page.keyboard.press('Escape');
  await button.click();
  const bindings = await page.evaluate(() => window.fixture.budgetCalls);
  assert.equal(bindings.length, 2); assert.deepEqual(bindings[0], bindings[1], 'Lost replies reuse the exact grant binding');
  assert.deepEqual(Object.keys(bindings[0]).sort(), ['budgetRevision', 'requestId', 'roundId', 'taskId']);
  await page.evaluate(() => {
    const snapshot = window.fixture.budgetSnapshot; const task = snapshot.conversations[0];
    task.budget.roundLimit = 200; task.budget.budgetRevision++;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    window.fixture.budgetResolve({ budget: task.budget, continuation: 'acknowledged',
      grant: { requestId: window.fixture.budgetCalls[0].requestId, roundId: task.budget.roundId, phase: 'acknowledged' } });
  });
  await page.getByText('本轮请求 100/200 · 累计 300', { exact: true }).waitFor();
  assert.equal(await button.count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.separateResumes), 0, 'Renderer never dispatches an independent continuation');
  await screenshot('request-budget-confirmed.png');

  await page.evaluate(() => {
    window.cloudhelm.sendStructured = (input) => new Promise((resolve) => {
      window.fixture.summaryRequestId = input.document.requestId;
      window.fixture.summaryResolve = () => resolve({ conversationId: window.fixture.budgetSnapshot.conversations[0].id });
    });
  });
  await editor.fill('摘要进度本地测试'); await editor.press('Enter');
  await page.waitForFunction(() => !!window.fixture.summaryRequestId);
  await page.evaluate(() => window.fixture.inject({ type: 'message-preparation', requestId: window.fixture.summaryRequestId,
    status: 'compressing', summaryRequests: { used: 2, limit: 32 } }));
  await page.getByText('摘要请求 2/32', { exact: false }).waitFor();
  await screenshot('request-budget-summary.png');
  await page.evaluate(() => window.fixture.summaryResolve());
}
