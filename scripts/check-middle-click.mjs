/* global window, document */
import assert from 'node:assert/strict';

export async function checkMiddleClick(page, screenshot) {
  await page.reload();
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor();
  await page.getByRole('button', { name: /生产服务器 ubuntu@/ }).click();
  await page.getByRole('button', { name: /开发服务器 deployer@/ }).click();
  const dev = page.getByRole('button', { name: '开发服务器', exact: true });
  const prod = page.getByRole('button', { name: '生产服务器', exact: true });
  await dev.waitFor();
  const beforeClass = await dev.locator('..').getAttribute('class');
  await prod.click({ button: 'middle' });
  await prod.waitFor({ state: 'detached' });
  assert.equal(await dev.locator('..').getAttribute('class'), beforeClass, 'Closing a background tab must not select it');
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'close').length), 1);
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('中键关闭运行中的终端');
  // The composer briefly disables sending while the panel re-projects its
  // conversation; wait for it to become actionable instead of racing a render.
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return !!button && !button.hasAttribute('disabled');
  });
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    const task = snapshot.conversations[0];
    window.fixture.inject({ type: 'terminal-state', terminalId: 'middle-agent', hostId: 'dev', taskId: task.id, state: 'agent' });
    snapshot.terminals.push({ id: 'middle-agent', hostId: 'dev', taskId: task.id, state: 'agent' });
    snapshot.operations.push({ id: 'middle-op', taskId: task.id, hostId: 'dev', kind: 'command', preview: 'sleep 30', status: 'running', logRef: 'middle-agent', createdAt: Date.now() });
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await page.getByRole('button', { name: '打开 AI 专用终端' }).click();
  const ai = page.getByRole('button', { name: '开发服务器 · AI', exact: true });
  await dev.click();
  await ai.click({ button: 'middle' });
  const confirm = page.getByRole('alertdialog', { name: '断开正在运行的 AI 终端？' });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await ai.count(), 1);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'close').length), 1);
  await ai.click({ button: 'middle' });
  await confirm.getByRole('button', { name: '断开并关闭' }).click();
  await ai.waitFor({ state: 'detached' });
  assert.equal(await dev.locator('..').getAttribute('class'), beforeClass);
  await screenshot('middle-click-background-closed.png');
}
