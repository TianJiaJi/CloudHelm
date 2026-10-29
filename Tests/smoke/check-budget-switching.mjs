/* global window, structuredClone */
import assert from 'node:assert/strict';

/** Regression: keyed budget and composer must never share a sibling key. */
export async function checkBudgetSwitching(page, screenshot) {
  await page.reload();
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  const warnings = [];
  const record = (message) => { if (/same key|unique.*key/iu.test(message.text())) warnings.push(message.text()); };
  page.on('console', record);
  try {
    await page.evaluate(async () => {
      const snapshot = await window.cloudhelm.snapshot();
      snapshot.conversations = [8, 1, 3].map((used, index) => ({
        id: `budget-switch-${index}`, goal: `统计切换回归${index}`, hostIds: [], localScopes: [], status: 'answered',
        provider: 'openai', modelId: 'gpt-5.4', session: { version: 1, id: `budget-switch-${index}` },
        requestCount: used, requestLimit: 100, createdAt: index + 1, updatedAt: index + 1,
        budget: { version: 1, roundId: `round-${index}`, budgetRevision: 1, roundUsed: used, roundLimit: 100,
          defaultRoundLimit: 100, totalUsed: index === 0 ? 14 : used, closed: false, origin: 'explicit' }
      }));
      snapshot.messages = snapshot.conversations.map((task) => ({ taskId: task.id, role: 'user', text: `消息${task.id}`, createdAt: 1 }));
      window.fixture.budgetSwitchSnapshot = snapshot;
      window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    });
    const panel = page.locator('aside[class*="agentPanel"]');
    for (const index of [0, 1, 2, 0, 2, 1, 0]) {
      await page.getByRole('button', { name: new RegExp(`统计切换回归${index}`, 'u') }).click();
      await panel.getByText(`消息budget-switch-${index}`, { exact: true }).waitFor();
      const lines = await panel.getByText(/^本轮请求 /u).allTextContents();
      await screenshot('budget-conversation-switch.png');
      assert.deepEqual(lines, [`本轮请求 ${[8, 1, 3][index]}/100 · 累计 ${index === 0 ? 14 : [8, 1, 3][index]}`],
        `Switching to conversation ${index} must leave exactly its own budget row`);
    }
    await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('当前对话草稿');
    await page.evaluate(() => {
      const snapshot = window.fixture.budgetSwitchSnapshot;
      snapshot.conversations[0].budget.roundUsed = 9;
      snapshot.conversations[0].budget.totalUsed = 15;
      window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    });
    await panel.getByText('本轮请求 9/100 · 累计 15', { exact: true }).waitFor();
    assert.equal(await panel.getByText(/^本轮请求 /u).count(), 1);
    assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).textContent(), '当前对话草稿');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    assert.equal(await panel.getByText(/^本轮请求 /u).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).textContent(), '');
    await page.getByRole('button', { name: /统计切换回归0/u }).click();
    await panel.getByText('本轮请求 9/100 · 累计 15', { exact: true }).waitFor();
    assert.equal(await panel.getByText(/^本轮请求 /u).count(), 1);
    assert.equal(await page.getByRole('textbox', { name: '给 AI 的消息' }).textContent(), '当前对话草稿');
    assert.deepEqual(warnings, [], 'Conversation switching must not emit duplicate sibling-key warnings');
    await screenshot('budget-conversation-switch-fixed.png');
  } finally { page.off('console', record); }
  await page.reload();
}
