/* global window */
import assert from 'node:assert/strict';

export async function checkExecutionThinking(page, screenshot) {
  await page.reload();
  const input = page.getByRole('textbox', { name: '给 AI 的消息' });
  await input.waitFor();
  await page.getByRole('button', { name: /生产服务器 ubuntu@/u }).click();
  await input.fill('检查停止与思考设置');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止执行', exact: true });
  await stop.waitFor();
  assert.equal(await input.textContent(), '');
  assert.equal(await stop.isEnabled(), true, 'Stop is independent of draft content');
  await input.fill('补充消息');
  await input.press('Enter');
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.kind === 'send'));
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'stop').length), 0);
  await input.fill('保留停止时的草稿');
  await page.getByRole('button', { name: '添加本地资料' }).click();
  await page.getByRole('menuitem', { name: '选择文件', exact: true }).click();
  await page.evaluate(() => {
    window.cloudhelm.stopOperation = (id) => {
      window.fixture.calls.push({ kind: 'stop-composer', id });
      window.fixture.inject({ type: 'execution', taskId: id, value: { model: 'idle', remote: 'running', canStop: true, stopping: true } });
      return new Promise((resolve) => { window.fixture.finishComposerStop = resolve; });
    };
  });
  await stop.click();
  const stopping = page.getByRole('button', { name: '正在停止', exact: true });
  assert.equal(await stopping.isDisabled(), true);
  await page.evaluate(() => window.fixture.finishComposerStop());
  await page.getByText('正在停止…模型已停；等待远端命令退出', { exact: true }).waitFor();
  assert.equal(await stopping.isDisabled(), true, 'IPC completion cannot prove remote exit');
  await input.press('Enter');
  assert.equal(await input.textContent(), '保留停止时的草稿');
  await screenshot('composer-stopping.png');
  await page.evaluate(async () => {
    const task = (await window.cloudhelm.snapshot()).conversations[0];
    window.fixture.inject({ type: 'execution', taskId: task.id, value: { model: 'idle', remote: 'unknown', canStop: false, stopping: false } });
  });
  await page.getByText('模型已停；远端结果待核验，请勿重复执行', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await input.textContent(), '保留停止时的草稿');
  assert.equal(await page.getByRole('button', { name: '移除 /Users/demo/service' }).count(), 1);
  const thinking = page.getByRole('button', { name: /^思考强度/u });
  await thinking.click();
  const menu = page.getByRole('menu', { name: '思考强度', exact: true });
  await menu.getByRole('menuitem', { name: '高', exact: true }).click();
  await page.getByRole('button', { name: '思考强度，当前 高' }).waitFor();
  await page.getByText('高 · 下次', { exact: true }).waitFor();
  await page.evaluate(() => { window.cloudhelm.setConversationThinking = async () => { throw new Error('fixture thinking failure'); }; });
  await thinking.click();
  await menu.getByRole('menuitem', { name: '低', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '思考强度，当前 高' }).waitFor();
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
      const composer = page.locator('[class*="composerWrap"]').first();
      assert.equal(await composer.evaluate((element) => element.scrollWidth > element.clientWidth), false);
      const control = await thinking.boundingBox();
      const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
      assert.ok(control.x + control.width <= send.x);
      await thinking.click();
      await screenshot(`composer-thinking-${theme}-${width}.png`);
      await page.keyboard.press('Escape');
    }
  }
  await thinking.click();
  await screenshot('composer-thinking.png');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^对话模型/u }).click();
  await page.getByRole('menuitem', { name: /Custom reasoning model/u }).click();
  assert.equal(await thinking.count(), 0, 'unsupported models hide thinking');
}
