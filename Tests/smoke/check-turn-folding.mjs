/* global window, structuredClone */
import assert from 'node:assert/strict';

export async function checkTurnFolding(page, panel, screenshot) {
  const callsBefore = await page.evaluate(() => window.fixture.calls.length);
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot, task = snapshot.conversations[0];
    const now = Date.now();
    task.status = 'answered'; task.resumeReason = undefined;
    task.plan = task.plan.map((step) => ({ ...step, status: 'done' }));
    snapshot.execution = { [task.id]: { model: 'idle', remote: 'idle', stopping: false, canStop: false } };
    snapshot.reasoningProgress = {}; snapshot.approvals = []; snapshot.inputs = [];
    snapshot.operations = snapshot.operations.map((operation) => ({ ...operation, status: 'succeeded', exitCode: 0, completedAt: now - 1 }));
    snapshot.messages.push({ taskId: task.id, role: 'agent', entryId: 'final-first', text: '最终检查结果：磁盘正常，服务已确认。', createdAt: now,
      reasoning: { text: '本轮收尾思考', kind: 'thinking', status: 'complete' } });
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const answer = panel.getByText('最终检查结果：磁盘正常，服务已确认。', { exact: true });
  await answer.waitFor();
  const process = panel.locator('details[class*="turnProcess"]').first();
  await process.locator(':scope > summary').waitFor();
  assert.match(await process.locator(':scope > summary').innerText(), /2 次操作/u);
  assert.equal(await process.getAttribute('open'), null);
  assert.equal(await panel.locator('form').getByRole('region', { name: '执行计划', exact: true }).count(), 0);
  assert.equal(await panel.getByText('df -h', { exact: true }).count(), 0);
  assert.equal(await panel.getByText('本轮结果', { exact: true }).count(), 0);
  await screenshot('completed-turn-collapsed.png');
  await process.locator(':scope > summary').click();
  await process.locator('code[title="df -h"]').waitFor();
  await process.getByRole('region', { name: '执行计划', exact: true }).waitFor();
  const reasoning = process.getByRole('region', { name: '思考内容', exact: true });
  await reasoning.getByRole('button').click();
  await reasoning.getByText('本轮收尾思考', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixture.aiPanelSnapshot.conversations[0].requestCount++;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(window.fixture.aiPanelSnapshot) });
  });
  assert.notEqual(await process.getAttribute('open'), null, 'Unrelated updates preserve the user expansion');
  assert.equal(await answer.isVisible(), true);
  await screenshot('completed-turn-expanded.png');
  await process.locator(':scope > summary').click();
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot, task = snapshot.conversations[0], now = Date.now();
    task.status = 'running'; task.plan = [{ id: 'next', title: '后续检查', status: 'running' }];
    snapshot.execution[task.id] = { model: 'running', remote: 'idle', stopping: false, canStop: true };
    snapshot.messages.push({ taskId: task.id, role: 'user', source: 'input', entryId: 'next-input', text: '再解释一下检查依据', createdAt: now },
      { taskId: task.id, role: 'agent', entryId: 'next-progress', text: '第二轮正在处理', createdAt: now + 1 });
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await panel.getByText('第二轮正在处理', { exact: true }).waitFor();
  assert.equal(await process.getAttribute('open'), null, 'A new turn does not reopen previous work');
  await panel.locator('form').getByRole('region', { name: '执行计划', exact: true }).waitFor();
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot, task = snapshot.conversations[0];
    task.status = 'answered'; task.plan[0].status = 'done';
    snapshot.execution[task.id] = { model: 'idle', remote: 'idle', stopping: false, canStop: false };
    snapshot.messages.push({ taskId: task.id, role: 'agent', entryId: 'next-final', text: '第二轮最终说明', createdAt: Date.now() + 10 });
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await panel.getByText('第二轮最终说明', { exact: true }).waitFor();
  assert.equal(await panel.locator('details[class*="turnProcess"]').count(), 2);
  assert.equal(await panel.locator('details[class*="turnProcess"][open]').count(), 0);
  assert.equal(await answer.isVisible(), true);
  await screenshot('multiple-turns-collapsed.png');
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot, task = snapshot.conversations[0];
    const final = snapshot.messages.at(-1);
    snapshot.operations.push({ id: 'late-unknown', taskId: task.id, hostId: 'prod', kind: 'command',
      preview: 'systemctl restart example.service', status: 'unknown', effects: 'possible', createdAt: final.createdAt - 1 });
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await panel.getByRole('region', { name: '本次远端写入风险确认', exact: true }).waitFor();
  await panel.getByText('systemctl restart example.service', { exact: true }).first().waitFor();
  assert.equal(await panel.locator('details[class*="turnProcess"]').count(), 1, 'Unknown outcomes are not hidden by an answered status or done plan');
  assert.equal(await page.evaluate(() => window.fixture.calls.length), callsBefore, 'Expanding history must not send, resume, approve, or replay work');
}
