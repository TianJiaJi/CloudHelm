/* global window, document, structuredClone */
import assert from 'node:assert/strict';

/** Renderer-only synthetic observations. No model, SSH, credentials or process signals. */
export async function checkExecutionWorkspace(page, panel, screenshot) {
  await page.clock.install();
  await page.evaluate(() => {
    const snapshot = structuredClone(window.fixture.aiPanelSnapshot), task = snapshot.conversations[0], at = Date.now();
    window.fixture.workspaceOriginalMethods = Object.fromEntries(['snapshot', 'sendStructured', 'cancelQueuedInput', 'readOperationLog', 'stopOperation', 'pauseConversation'].map((name) => [name, window.cloudhelm[name]]));
    window.fixture.workspaceCalls = []; window.fixture.workspaceSnapshot = snapshot;
    const calls = window.fixture.workspaceCalls, sync = () => window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    task.status = 'running'; task.plan = []; task.intent = { version: 1, revision: 1, originalGoal: 'synthetic', currentInput: 'active intent unchanged', origin: 'explicit', clarifications: [] };
    snapshot.messages = [{ taskId: task.id, role: 'user', text: '启动后台服务，再诊断磁盘', createdAt: at - 10 },
      { taskId: task.id, role: 'agent', text: '回答已经完成；后台进程仍需独立观察。', createdAt: at - 1 }];
    snapshot.approvals = []; snapshot.inputs = []; snapshot.clarifications = []; snapshot.reasoningProgress = {};
    snapshot.terminals.push({ id: 'workspace-A', hostId: 'prod', taskId: task.id, state: 'agent' }, { id: 'workspace-B', hostId: 'prod', taskId: task.id, state: 'agent' });
    const job = { version: 1, jobId: 'job-A', operationId: 'workspace-operation', taskId: task.id, hostId: 'prod', terminalId: 'workspace-A', terminalGeneration: 1,
      connectionId: 'synthetic-connection', loginAs: 'fixture', runAs: 'fixture', status: 'running', createdAt: at - 8, updatedAt: at - 5, pid: 42, processSequence: 1, exitObserved: false };
    snapshot.operations = [{ id: job.operationId, taskId: task.id, hostId: 'prod', kind: 'command', preview: 'python3 -m http.server 8080', status: 'running', createdAt: at - 8, logRef: job.terminalId, executionJob: job },
      { id: 'workspace-diagnostic', taskId: task.id, hostId: 'prod', kind: 'command', preview: 'df -h', status: 'succeeded', readOnly: true, createdAt: at - 4, completedAt: at - 2, logRef: 'workspace-B', outputTail: 'synthetic disk observation', exitCode: 0 }];
    snapshot.execution = { [task.id]: { model: 'running', remote: 'running', stopping: false, canStop: true } };
    snapshot.agentActivity = { [task.id]: { version: 1, omittedTools: 0, omittedRequests: 0, tools: [
      { kind: 'tool', runId: 'run', callId: 'parent', nativeId: 'hash-parent', name: 'codemode', status: 'running', startedAt: at, observedAt: at, updates: 0 },
      { kind: 'tool', runId: 'run', callId: 'child', nativeId: 'hash-child', name: 'query_operation_history', parentCallId: 'parent', status: 'running', startedAt: at, observedAt: at, updates: 1 }],
      requests: [{ kind: 'request', logicalRequestId: 'request', attempt: 1, purpose: 'conversation', provider: 'synthetic', modelId: 'fixture', status: 'complete', startedAt: at - 5, observedAt: at - 2, cost: { source: 'unknown', usd: null } }] } };
    snapshot.queuedInputs = ['expired', 'failed'].map((status) => ({ version: 1, id: status, taskId: task.id, kind: 'followUp', status,
      preview: `历史${status}`, createdAt: at - 5, updatedAt: at, expiresAt: at + 60000, reason: status === 'expired' ? 'recovered' : 'delivery-failed' }));
    window.cloudhelm.snapshot = async () => structuredClone(snapshot);
    window.cloudhelm.sendStructured = async (input) => {
      calls.push({ kind: 'send', input });
      snapshot.queuedInputs.push({ version: 1, id: input.document.requestId, taskId: task.id, kind: input.queueMode, status: 'queued',
        preview: input.document.parts.map((part) => part.text ?? '').join(''), createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000 });
      sync(); return { conversationId: task.id };
    };
    window.cloudhelm.cancelQueuedInput = async (taskId, inputId) => {
      calls.push({ kind: 'cancel', taskId, inputId });
      await new Promise((resolve) => { window.fixture.releaseQueueCancel = resolve; });
      const input = snapshot.queuedInputs.find((value) => value.id === inputId);
      input.status = 'cancelled'; input.reason = 'cancelled'; sync(); return { cancelled: true };
    };
    window.cloudhelm.readOperationLog = async (taskId, operationId, cursor) => {
      calls.push({ kind: 'log', taskId, operationId, cursor });
      if (taskId !== task.id || operationId !== job.operationId) throw new Error('wrong operation recipient');
      if (window.fixture.failWorkspaceLog) throw new Error('synthetic local log failure');
      if (window.fixture.holdWorkspaceLog) await new Promise((resolve) => { window.fixture.releaseWorkspaceLog = resolve; });
      return cursor === 0 ? { text: 'A first output\n', nextCursor: 10, more: false } : window.fixture.extraWorkspaceLog && cursor === 10
        ? { text: 'A later output\n', nextCursor: 20, more: false } : { text: '', nextCursor: cursor, more: false };
    };
    window.cloudhelm.stopOperation = async (taskId) => {
      calls.push({ kind: 'stop', taskId }); job.status = 'stop-requested'; job.stopRequestId = 'synthetic-stop';
      task.status = 'paused'; snapshot.execution[task.id] = { model: 'idle', remote: 'running', stopping: false, canStop: false }; sync();
    };
    window.cloudhelm.pauseConversation = async (taskId) => {
      calls.push({ kind: 'pause', taskId }); task.status = 'paused'; snapshot.execution[task.id].model = 'idle';
      snapshot.agentActivity[task.id].tools.forEach((tool) => { tool.status = 'interrupted'; });
      snapshot.queuedInputs.forEach((input) => { if (input.status === 'queued') { input.status = 'cancelled'; input.reason = 'cancelled'; } }); sync();
    };
    sync();
  });
  try {
    const input = panel.getByRole('textbox', { name: '给 AI 的消息', exact: true });
    const delivery = panel.getByLabel('消息投递方式', { exact: true });
    await delivery.selectOption('steer'); await input.fill('相同内容'); await input.press('Enter');
    await panel.getByText('当前调整 · 待投递', { exact: true }).waitFor();
    await delivery.selectOption('followUp'); await input.fill('相同内容'); await input.press('Enter');
    await panel.getByText('后续排队 · 待投递', { exact: true }).waitFor();
    const sends = await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'send'));
    assert.deepEqual(sends.map((call) => call.input.queueMode), ['steer', 'followUp']);
    assert.notEqual(sends[0].input.document.requestId, sends[1].input.document.requestId);
    assert.equal(await page.evaluate(() => window.fixture.workspaceSnapshot.conversations[0].intent.currentInput), 'active intent unchanged');
    const queue = panel.getByRole('region', { name: '消息队列', exact: true });
    const first = queue.locator('[data-input-status="queued"]').first();
    await first.getByRole('button', { name: '取消此消息', exact: true }).click();
    await first.getByRole('button', { name: '取消确认中…', exact: true }).waitFor();
    assert.equal(await first.getAttribute('data-input-status'), 'queued', 'Cancellation cannot be optimistic');
    await page.evaluate(() => window.fixture.releaseQueueCancel());
    await queue.locator('summary').click(); await queue.getByText('当前调整 · 已取消', { exact: true }).waitFor();
    await queue.getByText('后续排队 · 已过期', { exact: true }).waitFor();
    await queue.getByText('后续排队 · 投递失败', { exact: true }).waitFor();
    await panel.getByText('回答已经完成；后台进程仍需独立观察。', { exact: true }).waitFor();
    const activity = panel.getByRole('region', { name: '独立执行状态', exact: true });
    assert.match(await activity.innerText(), /工具：2 个执行中/u); assert.match(await activity.innerText(), /费用未知/u);
    const job = panel.getByRole('region', { name: '后台任务状态', exact: true });
    await job.getByText('后台运行 · 健康未确认', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '查看增量日志', exact: true }).click();
    const log = panel.getByRole('region', { name: '操作增量日志', exact: true });
    await log.getByText('A first output', { exact: false }).waitFor();
    await page.evaluate(() => { window.fixture.holdWorkspaceLog = true; });
    await log.getByRole('button', { name: '刷新留存日志', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.releaseWorkspaceLog === 'function');
    const readCount = await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'log').length);
    await page.clock.fastForward(4000);
    assert.equal(await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'log').length), readCount, 'No overlapping local log reads');
    await input.fill('未发送的草稿'); await input.focus();
    const tab = page.locator('[class*="activeTab"] [class*="tabSelect"]');
    const selected = await tab.getAttribute('title');
    await page.evaluate(() => {
      window.fixture.extraWorkspaceLog = true; window.fixture.holdWorkspaceLog = false; window.fixture.releaseWorkspaceLog();
      window.fixture.inject({ type: 'terminal-data', terminalId: 'workspace-A', data: 'must not mix terminal buffer into the operation log' });
    });
    await log.getByText(/A later output/u).waitFor();
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    assert.equal(await tab.getAttribute('title'), selected);
    assert.equal((await log.innerText()).includes('must not mix'), false);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); });
    const hiddenReads = await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'log').length);
    await page.clock.fastForward(4000);
    assert.equal(await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'log').length), hiddenReads);
    await page.evaluate(() => { delete document.visibilityState; window.fixture.failWorkspaceLog = true; });
    await page.clock.fastForward(2100); await log.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'Background log failure stays inline');
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    await activity.getByRole('button', { name: '暂停模型（后台继续）', exact: true }).click();
    await activity.getByText('模型：空闲', { exact: true }).waitFor();
    assert.equal(await job.getAttribute('data-job-status'), 'running');
    page.once('dialog', (dialog) => dialog.dismiss());
    await job.getByRole('button', { name: '停止本会话执行', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'stop').length), 0);
    page.once('dialog', (dialog) => dialog.accept());
    await job.getByRole('button', { name: '停止本会话执行', exact: true }).click();
    await job.getByText('已请求停止 · 尚未确认退出', { exact: true }).waitFor();
    assert.equal(await job.getByRole('button', { name: '停止本会话执行', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'send').length), 2);
    assert.equal(await page.evaluate(() => window.fixture.workspaceCalls.filter((call) => call.kind === 'stop').length), 1);
    await screenshot('execution-workspace-stop-requested.png');
    await page.evaluate(() => {
      const snapshot = window.fixture.workspaceSnapshot, operation = snapshot.operations[0];
      operation.executionJob.status = 'unknown'; operation.executionJob.unknownReason = 'disconnected'; operation.status = 'unknown';
      snapshot.execution[operation.taskId].remote = 'unknown';
      window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
    });
    await job.getByText('结果未知 · 待核验', { exact: true }).waitFor();
    assert.equal(await panel.locator('details[class*="turnProcess"]').count(), 0);
    assert.equal(await input.textContent(), '未发送的草稿');
    await screenshot('execution-workspace-unknown.png');
  } finally {
    await page.evaluate(() => { delete document.visibilityState; Object.assign(window.cloudhelm, window.fixture.workspaceOriginalMethods); window.fixture.inject({ type: 'snapshot', value: structuredClone(window.fixture.aiPanelSnapshot) }); });
    await page.clock.resume();
  }
}
