/* global window */
import assert from 'node:assert/strict';

export async function checkClarification(page, screenshot) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  const composer = page.getByRole('textbox', { name: '给 AI 的消息' });
  await composer.fill('配置部署方式');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    const task = snapshot.conversations[0];
    task.status = 'waiting-user';
    snapshot.clarifications = [{ id: 'clarification', taskId: task.id, generation: 'run', toolCallId: 'tool', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 86400000,
      questions: [{ id: 'environment', prompt: '部署到哪个环境？', options: [{ value: 'test', label: '测试环境', recommended: true, description: '先验证配置，降低影响。' }, { value: 'prod', label: '生产环境', description: '直接用于正式服务。' }] }] }];
    window.fixture.clarificationSnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: snapshot });
    window.cloudhelm.answerClarification = async (taskId, requestId, answers) => {
      window.fixture.calls.push({ kind: 'clarification', taskId, requestId, answers });
      if (!window.fixture.clarificationRetry) { window.fixture.clarificationRetry = true; throw new Error('连接暂不可用，请重试'); }
      snapshot.clarifications[0].status = 'answered'; snapshot.clarifications[0].answers = answers; task.status = 'running';
      window.fixture.inject({ type: 'snapshot', value: snapshot });
    };
    window.cloudhelm.cancelClarification = async () => {
      snapshot.clarifications[0].status = 'cancelled'; task.status = 'paused';
      window.fixture.inject({ type: 'snapshot', value: snapshot });
    };
  });
  const card = page.getByRole('region', { name: '需求澄清' });
  await card.waitFor();
  assert.equal(await composer.isDisabled(), true);
  assert.equal(await card.getByRole('button', { name: '提交并继续' }).isDisabled(), true);
  assert.equal(await card.getByRole('radio', { name: /测试环境/ }).isChecked(), false, 'A recommendation is not a submitted answer');
  await card.getByRole('radio', { name: '自定义回答' }).check();
  await card.getByRole('textbox').fill('先部署到预发布环境');
  await screenshot('clarification-dark.png');
  // Remount the conversation to verify drafts are retained while switching tabs/conversations.
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: /配置部署方式/ }).click();
  assert.equal(await card.getByRole('textbox').inputValue(), '先部署到预发布环境');
  await card.getByRole('button', { name: '提交并继续' }).click();
  await card.getByRole('alert').waitFor();
  assert.equal(await card.getByRole('textbox').inputValue(), '先部署到预发布环境');
  await card.getByRole('button', { name: '提交并继续' }).dblclick();
  await card.getByText('已回答', { exact: true }).waitFor();
  const submitted = await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'clarification'));
  assert.equal(submitted.length, 2, 'One failed attempt plus one successful attempt; double click cannot submit twice');
  assert.deepEqual(submitted[1].answers, [{ id: 'environment', value: '先部署到预发布环境', custom: true }]);
  await page.evaluate(() => {
    const snapshot = window.fixture.clarificationSnapshot;
    snapshot.clarifications[0] = { ...snapshot.clarifications[0], id: 'second', status: 'pending', answers: undefined };
    snapshot.conversations[0].status = 'waiting-user';
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await screenshot('clarification-light.png');
  await card.getByRole('button', { name: '停止本轮' }).click();
  await card.getByText('已停止', { exact: true }).waitFor();
  assert.equal(await composer.isDisabled(), false);
  await page.evaluate(() => {
    const snapshot = window.fixture.clarificationSnapshot;
    snapshot.clarifications[0].status = 'expired';
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await card.getByText('已失效', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: '提交并继续' }).count(), 0);
  await page.emulateMedia({ colorScheme: 'dark' });
}
