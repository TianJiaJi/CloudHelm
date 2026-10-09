/* global window, structuredClone, document */
import assert from 'node:assert/strict';

export async function checkReasoningContent(page, screenshot) {
  await page.reload();
  const input = page.getByRole('textbox', { name: '给 AI 的消息' });
  await input.fill('检查思考内容展示');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    const task = snapshot.conversations[0];
    snapshot.reasoningProgress = { [task.id]: { id: 'stream-reasoning', createdAt: Date.now(),
      model: { provider: task.provider, modelId: task.modelId }, reasoning: { text: '先查看服务状态，再核对退出码。', status: 'streaming', kind: 'thinking' } } };
    window.fixture.reasoningSnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const card = page.getByRole('region', { name: '思考内容', exact: true });
  await card.getByText('先查看服务状态，再核对退出码。', { exact: true }).waitFor();
  await card.getByText('正在接收…', { exact: true }).waitFor();
  await card.getByRole('button').click();
  assert.equal(await card.getByText('先查看服务状态，再核对退出码。').count(), 0);
  await page.evaluate(() => {
    const snapshot = window.fixture.reasoningSnapshot;
    const task = snapshot.conversations[0];
    snapshot.reasoningProgress[task.id].reasoning.text += '\n需要检查的内容持续返回。';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  assert.equal(await card.getByRole('button').getAttribute('aria-expanded'), 'false');
  await card.getByRole('button').click();
  await card.getByText(/需要检查的内容持续返回/u).waitFor();
  const panel = page.locator('[class*="agentPanel"]').first();
  const resizer = page.getByRole('separator', { name: '调整 AI 助手宽度' });
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [330, 620]) {
      const bounds = await resizer.boundingBox(); const current = (await panel.boundingBox()).width;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100); await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + current - width, bounds.y + 100); await page.mouse.up();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await screenshot(`reasoning-${theme}-${width}.png`);
    }
  }
  await page.evaluate(() => {
    const snapshot = window.fixture.reasoningSnapshot; const task = snapshot.conversations[0];
    snapshot.messages.push({ taskId: task.id, entryId: 'thinking-final', role: 'agent', text: '服务检查已完成。', createdAt: Date.now(),
      reasoning: { ...snapshot.reasoningProgress[task.id].reasoning, status: 'complete' } });
    snapshot.reasoningProgress = {};
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  assert.equal(await card.count(), 1, 'final projection replaces live content without duplication');
  await card.getByText('已完成', { exact: true }).waitFor();
  await page.getByText('服务检查已完成。', { exact: true }).waitFor();
  await page.evaluate(() => {
    const snapshot = window.fixture.reasoningSnapshot; const task = snapshot.conversations[0];
    snapshot.messages.push({ taskId: task.id, entryId: 'summary-only', role: 'agent', text: '', createdAt: Date.now() + 1,
      reasoning: { text: '接口提供的摘要内容。', kind: 'summary', status: 'interrupted' } });
    snapshot.messages.push({ taskId: task.id, entryId: 'no-content', role: 'agent', text: '这是正常回答。', createdAt: Date.now() + 2,
      reasoning: { text: '', kind: 'thinking', status: 'unavailable' } });
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.getByRole('region', { name: '思考摘要', exact: true }).getByText('已中断', { exact: true }).waitFor();
  await page.getByText('此响应未返回可展示的思考内容。', { exact: true }).waitFor();
  await screenshot('reasoning-completed-and-unavailable.png');
}
