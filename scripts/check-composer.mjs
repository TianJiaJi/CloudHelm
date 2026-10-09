/* global window, document */
import assert from 'node:assert/strict';

export async function checkComposer(page, screenshot) {
  const attachment = page.getByRole('button', { name: '添加本地资料', exact: true });
  const attachments = page.getByRole('menu', { name: '添加本地资料', exact: true });
  const composerForm = page.locator('form').filter({ has: attachment });
  const composerBounds = await composerForm.boundingBox();
  const attachmentBounds = await attachment.boundingBox();
  await attachment.click();
  await attachments.waitFor();
  assert.deepEqual(await composerForm.boundingBox(), composerBounds, 'attachment menu does not resize or move the composer');
  assert.deepEqual(await attachment.boundingBox(), attachmentBounds, 'attachment trigger stays in place');
  assert.equal(await attachments.evaluate((element) => element.matches(':popover-open')), true, 'attachment menu uses the top layer');
  const attachmentPopup = await attachments.boundingBox();
  assert.ok(attachmentPopup.y + attachmentPopup.height <= composerBounds.y - 4, 'attachment menu floats above the entire composer');
  assert.ok(Math.abs(attachmentPopup.x - composerBounds.x) < 1, 'attachment menu aligns with the composer left edge');
  await screenshot('composer-attachments.png');
  await page.keyboard.press('Escape');
  await attachments.waitFor({ state: 'hidden' });
  assert.equal(await attachment.evaluate((element) => document.activeElement === element), true, 'Escape restores attachment trigger focus');
  await attachment.click();
  const message = page.getByRole('textbox', { name: '给 AI 的消息' });
  await message.click({ position: { x: (await message.boundingBox()).width - 5, y: 5 } });
  await attachments.waitFor({ state: 'hidden' });
  await attachment.click();
  await attachment.click();
  await attachments.waitFor({ state: 'hidden' });

  const trigger = page.getByRole('button', { name: /^对话模型/u });
  const menu = page.getByRole('menu', { name: '对话模型', exact: true });
  await trigger.click();
  const search = menu.getByRole('searchbox', { name: '搜索模型' });
  await search.fill('not-a-real-model');
  await menu.getByText('没有匹配的模型').waitFor();
  await search.fill('sonnet');
  assert.equal(await menu.getByRole('menuitem').count(), 2, 'filtered model and reapply action remain');
  await search.press('Home');
  assert.equal(await search.evaluate((element) => document.activeElement === element), true, 'Home edits search instead of moving menu focus');
  await search.press('ArrowDown');
  assert.equal(await menu.getByRole('menuitem', { name: /Claude Sonnet/u }).evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);

  const permission = page.getByRole('button', { name: /^权限选择/u });
  await permission.click();
  const permissions = page.getByRole('menu', { name: '权限选择', exact: true });
  assert.equal(await permissions.getByRole('menuitem').count(), 3);
  await screenshot('composer-permissions.png');
  await permissions.getByRole('menuitem', { name: /人工批准/u }).click();
  await page.getByRole('button', { name: '权限选择，当前 人工批准' }).waitFor();
  assert.equal((await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'review-mode'))).at(-1).mode, 'ask');
  await page.evaluate(() => {
    window.fixture.restoreReviewMode = window.cloudhelm.updateHostReviewMode;
    window.cloudhelm.updateHostReviewMode = async () => { throw new Error('Task runtime is unavailable'); };
  });
  await permission.click();
  await permissions.getByRole('menuitem', { name: /^自动执行/u }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '权限选择，当前 人工批准' }).waitFor();
  await page.evaluate(() => { window.cloudhelm.updateHostReviewMode = window.fixture.restoreReviewMode; });
  await permission.click();
  await permissions.getByRole('menuitem', { name: /AI 审核/u }).click();

  await page.getByRole('button', { name: '上下文用量，上下文待统计' }).waitFor();
  await page.evaluate(async () => {
    const task = (await window.cloudhelm.snapshot()).conversations[0];
    window.fixture.inject({ type: 'context-compaction', taskId: task.id, status: 'running' });
  });
  await page.getByRole('button', { name: '上下文用量，正在整理上下文…' }).waitFor();
  await page.evaluate(async () => {
    const task = (await window.cloudhelm.snapshot()).conversations[0];
    window.fixture.inject({ type: 'context-compaction', taskId: task.id, status: 'complete' });
  });
  await page.getByRole('button', { name: '上下文用量，上下文待统计' }).waitFor();
  await page.evaluate(async () => {
    const task = (await window.cloudhelm.snapshot()).conversations[0];
    window.fixture.inject({ type: 'context-usage', taskId: task.id, value: {
      model: { provider: task.provider, modelId: task.modelId }, usedTokens: 32000, contextWindow: 128000,
      request: 2, source: 'estimate', updatedAt: Date.now()
    } });
  });
  const usage = page.getByRole('button', { name: '上下文用量，约剩余 75%' });
  await usage.waitFor();
  await usage.click();
  const detail = page.getByRole('menu', { name: '上下文用量', exact: true });
  await detail.getByText(/32,000 \/ 128,000 tokens/u).waitFor();
  await screenshot('composer-context.png');
  await page.keyboard.press('Escape');
  await trigger.click();
  await menu.getByRole('menuitem', { name: /Custom reasoning model/u }).click();
  await page.getByRole('button', { name: '上下文用量，上下文待统计' }).waitFor();
  await page.evaluate(async () => {
    const task = (await window.cloudhelm.snapshot()).conversations[0];
    window.fixture.inject({ type: 'context-usage', taskId: task.id, value: {
      model: { provider: task.provider, modelId: task.modelId }, usedTokens: 32000, contextWindow: 128000,
      request: 3, source: 'provider', updatedAt: Date.now()
    } });
  });
  await page.getByRole('button', { name: '上下文用量，剩余 75%' }).waitFor();

  const panel = page.locator('[class*="agentPanel"]').first();
  const resizer = page.getByRole('separator', { name: '调整 AI 助手宽度' });
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [330, 400, 620]) {
      const bounds = await resizer.boundingBox();
      const current = (await panel.boundingBox()).width;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + current - width, bounds.y + 100);
      await page.mouse.up();
      assert.ok(Math.abs((await panel.boundingBox()).width - width) < 2);
      const composer = page.locator('[class*="composerWrap"]').first();
      assert.equal(await composer.evaluate((element) => element.scrollWidth > element.clientWidth), false, 'composer stays inside narrow panel');
      await screenshot(`composer-${theme}-${width}.png`);
      await trigger.click();
      const popup = await menu.boundingBox();
      assert.ok(popup && popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= page.viewportSize().width);
      await screenshot(`composer-models-${theme}-${width}.png`);
      await page.keyboard.press('Escape');
    }
  }
  await trigger.click();
  await menu.getByRole('menuitem', { name: /Claude Sonnet/u }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  const bounds = await resizer.boundingBox();
  const current = (await panel.boundingBox()).width;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + current - 400, bounds.y + 100);
  await page.mouse.up();
}
