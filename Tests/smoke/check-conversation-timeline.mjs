/* global window, document, structuredClone */
import assert from 'node:assert/strict';

export async function checkConversationTimeline(page, screenshot) {
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    window.fixture.beforeTimeline = snapshot;
    const next = structuredClone(snapshot);
    const taskId = next.conversations[0].id;
    next.conversations[0].status = 'running';
    next.conversations[0].plan = [];
    next.approvals = [];
    next.inputs = [];
    next.messages = [
      { taskId, role: 'user', text: '检查这台服务器的磁盘占用', createdAt: 100 },
      { taskId, role: 'agent', text: '我会检查文件系统使用情况。', createdAt: 200 }
    ];
    next.operations = [{ id: 'disk-check', taskId, hostId: 'prod', kind: 'command', preview: 'df -h',
      status: 'succeeded', exitCode: 0, outputTail: '/dev/sda1 145G 54G 92G 37% /', createdAt: 300 }];
    window.fixture.timelineSnapshot = next;
    window.fixture.inject({ type: 'snapshot', value: next });
  });
  await page.getByRole('status').filter({ hasText: 'AI 正在准备下一步' }).waitFor();
  await page.evaluate(() => {
    const next = structuredClone(window.fixture.timelineSnapshot);
    next.conversations[0].status = 'paused';
    // A fast reply may share the operation's millisecond timestamp.
    next.messages.push({ taskId: next.conversations[0].id, role: 'agent',
      text: '根分区使用率 **37%**，剩余 **92G**，目前空间充足。', createdAt: 300 });
    window.fixture.timelineSnapshot = next;
    window.fixture.inject({ type: 'snapshot', value: next });
  });
  const summary = page.locator('article').filter({ hasText: '根分区使用率' });
  await summary.waitFor();
  assert.equal(await page.getByText('AI 正在准备下一步…', { exact: true }).count(), 0);
  const order = () => page.evaluate(() => {
    const main = document.querySelector('[class*="agentScroll"]');
    return main.innerText;
  });
  let text = await order();
  assert.ok(text.indexOf('检查这台服务器') < text.indexOf('我会检查'));
  assert.ok(text.indexOf('我会检查') < text.indexOf('df -h'));
  assert.ok(text.indexOf('df -h') < text.indexOf('根分区使用率'), 'Final analysis must follow command output');
  await screenshot('disk-analysis-timeline.png');
  await page.evaluate(() => {
    const next = structuredClone(window.fixture.timelineSnapshot);
    const taskId = next.conversations[0].id;
    next.messages.push({ taskId, role: 'user', text: '再看看 inode', createdAt: 400 },
      { taskId, role: 'agent', text: 'inode 使用率为 3%，目前充足。', createdAt: 600 });
    next.operations.push({ ...next.operations[0], id: 'inode-check', preview: 'df -i',
      outputTail: '/dev/sda1 100000 3000 97000 3% /', createdAt: 500 });
    window.fixture.inject({ type: 'snapshot', value: next });
  });
  await page.getByText('inode 使用率为 3%，目前充足。', { exact: true }).waitFor();
  text = await order();
  assert.ok(text.indexOf('根分区使用率') < text.indexOf('再看看 inode'));
  assert.ok(text.indexOf('再看看 inode') < text.indexOf('df -i'));
  assert.ok(text.indexOf('df -i') < text.indexOf('inode 使用率为'));
  await page.evaluate(() => window.fixture.inject({ type: 'snapshot', value: window.fixture.beforeTimeline }));
}
