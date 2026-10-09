/* global window */
import { expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Exercises the built utility process, IPC, SQLite restart and actual Pi HTTP serialization. */
export async function checkClarificationRuntime(initialPage, restart) {
  const requests = [];
  const server = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const index = requests.length;
    const ask = [1, 3, 4].includes(index);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `reply-${index}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    send({ reasoning_content: '先确认部署环境，再执行后续检查。' });
    if (ask) send({ tool_calls: [{ index: 0, id: `ask-${index}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ id: 'environment', prompt: '部署到哪个环境？', options: [{ value: 'test', label: '测试环境', recommended: true }, { value: 'prod', label: '生产环境' }] }] }) } }] });
    else send({ content: '已收到，使用测试环境。' });
    send({}, ask ? 'tool_calls' : 'stop');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let page = initialPage;
  try {
    const taskId = await page.evaluate(async (baseUrl) => {
      await window.cloudhelm.saveModelProfile({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'local-smoke-dummy', baseUrl });
      const task = await window.cloudhelm.startConversation({ hostId: null, message: '帮助选择部署方式', localSelectionTokens: [] });
      return task.id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    const pending = async () => {
      let request;
      await expect.poll(async () => {
        request = await page.evaluate(async (id) => (await window.cloudhelm.snapshot()).clarifications?.find((q) => q.taskId === id && q.status === 'pending'), taskId);
        return request?.id;
      }, { timeout: 15000 }).toBeTruthy();
      return request;
    };
    const answer = async (requestId) => {
      await page.evaluate(async ({ taskId, requestId }) => window.cloudhelm.answerClarification(taskId, requestId, [{ id: 'environment', value: 'test' }]), { taskId, requestId });
      await expect.poll(() => page.evaluate(async (id) => (await window.cloudhelm.snapshot()).conversations.find((task) => task.id === id)?.status, taskId), { timeout: 15000 }).toBe('answered');
    };
    const first = await pending();
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.some((tool) => tool.function.name === 'ask_user'));
    assert.ok(requests[0].tools.every((tool) => !['bash', 'write', 'edit', 'read'].includes(tool.function.name)));
    await answer(first.id);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('"value":"test"')));
    await page.evaluate(async (id) => window.cloudhelm.sendMessage(id, '再确认一次部署环境'), taskId);
    const abandoned = await pending();
    page = await restart();
    const restored = await page.evaluate(async () => window.cloudhelm.snapshot());
    assert.equal(restored.clarifications.find((q) => q.id === abandoned.id).status, 'expired');
    assert.equal(restored.clarifications.find((q) => q.id === first.id).status, 'answered');
    assert.equal(restored.conversations.find((task) => task.id === taskId).status, 'paused');
    const late = await page.evaluate(async ({ taskId, requestId }) => {
      try { await window.cloudhelm.answerClarification(taskId, requestId, [{ id: 'environment', value: 'prod' }]); return 'accepted'; }
      catch { return 'rejected'; }
    }, { taskId, requestId: abandoned.id });
    assert.equal(late, 'rejected');
    assert.equal(requests.length, 3, 'Restart and late answers must not trigger model requests');
    await page.evaluate(async (id) => window.cloudhelm.sendMessage(id, '重启后继续，请重新询问'), taskId);
    const next = await pending();
    assert.notEqual(next.generation, abandoned.generation);
    await answer(next.id);
    assert.equal(requests.length, 5);
    assert.ok(requests[3].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'ask-1' && message.content.includes('"value":"test"')),
      'Native restoration keeps the original completed tool call and answer');
    assert.ok(restored.messages.some((message) => message.taskId === taskId && message.reasoning?.text === '先确认部署环境，再执行后续检查。'),
      'Desktop restart retains provider-returned thinking content');
    const projected = await page.evaluate(async (id) => (await window.cloudhelm.snapshot()).messages.filter((message) => message.taskId === id), taskId);
    const entryIds = projected.flatMap((message) => message.entryId ? [message.entryId] : []);
    assert.ok(entryIds.length >= 5);
    assert.equal(new Set(entryIds).size, entryIds.length, 'restoration must not duplicate native projection entries');
    return page;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
