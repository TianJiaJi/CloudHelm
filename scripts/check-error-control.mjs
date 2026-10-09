/* global window, structuredClone */
import assert from 'node:assert/strict';

export async function checkErrorControl(page, screenshot) {
  await page.reload();
  const composer = page.getByRole('textbox', { name: '给 AI 的消息' });
  await composer.waitFor();
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    snapshot.conversations = ['prod', 'dev'].map((hostId) => ({ id: `control-${hostId}`, session: { version: 1, id: `control-${hostId}` }, goal: `${hostId} 控制权测试`,
      hostIds: [hostId], localScopes: [], status: 'running', modelId: 'gpt-5.4', provider: 'openai',
      requestCount: 1, requestLimit: 100, createdAt: 1, updatedAt: 1 }));
    snapshot.terminals = snapshot.conversations.map((task) => ({ id: `terminal-${task.id}`, hostId: task.hostIds[0], taskId: task.id, state: 'agent' }));
    window.fixture.controlSnapshot = snapshot;
    window.cloudhelm.snapshot = async () => structuredClone(window.fixture.controlSnapshot);
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    window.cloudhelm.sendMessage = () => new Promise((_resolve, reject) => { window.fixture.rejectControlMessage = reject; });
    window.cloudhelm.stopOperation = (id) => {
      window.fixture.calls.push({ kind: 'stop-control', id });
      return new Promise((resolve, reject) => { window.fixture.finishControl = resolve; window.fixture.failControl = reject; });
    };
  });
  await page.getByRole('button', { name: /prod 控制权测试/ }).click();
  await composer.fill('保留这条未发送的消息');
  await page.getByRole('button', { name: '发送消息' }).click();
  // The error arrives after navigation: recovery must still target the original conversation.
  await page.getByRole('button', { name: /dev 控制权测试/ }).click();
  await page.evaluate(() => window.fixture.rejectControlMessage(new Error('AI 正在运行，请先停止再输入')));
  const dialog = page.getByRole('alertdialog', { name: '请先停止执行' });
  await dialog.waitFor();
  await dialog.getByText('关联对话：prod 控制权测试', { exact: true }).waitFor();
  await screenshot('terminal-control-warning.png');
  await dialog.getByRole('button', { name: '停止本轮', exact: true }).click();
  await dialog.getByRole('button', { name: '正在停止…' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '正在停止…' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 1);
  await page.evaluate(() => window.fixture.failControl(new Error('Host is not connected; password=hidden-control-secret')));
  await dialog.getByRole('alert').filter({ hasText: 'SSH 连接已断开' }).waitFor();
  assert.equal((await dialog.innerText()).includes('hidden-control-secret'), false);
  await dialog.getByRole('button', { name: '停止本轮', exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.filter((call) => call.kind === 'stop-control').length === 2);
  await page.evaluate(() => window.fixture.finishControl());
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'stop-control').map((call) => call.id)), ['control-prod', 'control-prod']);
  await page.getByRole('button', { name: /prod 控制权测试/ }).click();
  assert.equal(await composer.inputValue(), '保留这条未发送的消息');
  await page.evaluate(() => {
    const snapshot = window.fixture.controlSnapshot;
    const old = snapshot.conversations.find((task) => task.id === 'control-prod');
    delete old.session; old.status = 'paused';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await page.getByText('此旧对话仅供查看，无法恢复模型上下文。请开始新对话。').waitFor();
  assert.equal(await composer.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '继续 AI' }).count(), 0);
  await screenshot('legacy-conversation-readonly.png');

}
