/* global window */
import assert from 'node:assert/strict';

export async function checkTerminalControl(page, screenshot) {
  await page.reload();
  const composer = page.getByRole('textbox', { name: '给 AI 的消息' });
  await composer.waitFor();
  await page.getByRole('button', { name: /生产服务器 ubuntu@/ }).click();
  await composer.fill('测试停止后输入');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    window.fixture.inject({ type: 'terminal-state', terminalId: 'control-agent', hostId: 'prod', taskId: snapshot.conversations[0].id, state: 'agent' });
  });
  await page.getByRole('button', { name: '打开 AI 专用终端' }).click();
  assert.equal(await page.getByRole('button', { name: /接管终端|交还 AI/ }).count(), 0);
  await page.locator('.xterm-helper-textarea').press('p');
  const warning = page.getByRole('alertdialog', { name: '请先停止执行' });
  await warning.waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'input').length), 0);
  await warning.getByRole('button', { name: '停止本轮' }).click();
  await warning.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).count(), 0);
  await page.locator('.xterm-helper-textarea').pressSequentially('pwd');
  await page.waitForFunction(() => window.fixture.calls.filter((call) => call.kind === 'input').length === 3);
  const calls = await page.evaluate(() => window.fixture.calls);
  assert.equal(calls.filter((call) => call.kind === 'start').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'send' || call.kind === 'resume').length, 0);
  assert.equal(calls.filter((call) => call.kind === 'stop').length, 1);
  await screenshot('terminal-stopped-input.png');
}
