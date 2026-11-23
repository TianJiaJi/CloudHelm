import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it('settles an adjudication-required receipt through an explicit same-model re-proposal', async () => {
  let confirmed = false;
  const fixture = await openAiFixture(async (request) => {
    const transcript = request.messages.map(fixtureMessageText).join('\n');
    const reference = [...transcript.matchAll(/裁决引用: ([0-9a-f-]{36})/gu)].at(-1)?.[1];
    if (reference && !confirmed) {
      confirmed = true;
      return { calls: [{ id: 'confirm', name: 'run_remote', arguments: { hostId: 'host', command: 'customctl inspect',
        adjudications: [{ adjudicationId: reference, confirmed: true, basis: ['用户在任务目标中明确要求检查该服务状态'] }] } }] };
    }
    if (confirmed) return { text: '已确认执行并完成检查。' };
    return { calls: [{ id: 'propose', name: 'run_remote', arguments: { hostId: 'host', command: 'customctl inspect' } }] };
  });
  const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22,
    username: 'deploy', auth: 'agent', status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'self-adjudication-task', goal: '检查服务状态', hostIds: ['host'], localScopes: [],
    provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10,
    createdAt: 1, updatedAt: 1, reviewModesByHost: { host: 'ai-review' }, reviewRevision: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const execute = vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id,
    status: 'succeeded' as const, exitCode: 0, stdoutTail: 'ready' }));
  const requestApproval = vi.fn(async () => true);
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture',
    apiKey: 'test-key', baseUrl: fixture.baseUrl }, [], terminal, { execute },
    async () => terminal.open(host.id, { execute: vi.fn(), write() {}, close() {}, resize() {}, onExit() {}, onData() {}, onClose() {} },
      task.id, '/srv/app'),
    { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {} });
  try {
    await runner.start();
    const operations = events.filter((event) => event.type === 'operation').map((event) => event.value);
    expect(operations.find((operation) => operation.ruleId === 'adjudication-required'))
      .toMatchObject({ status: 'denied', manualReviewAvailable: false });
    expect(operations.filter((operation) => operation.ruleId === 'self-adjudication-confirmed').at(-1))
      .toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({ command: 'customctl inspect' });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests.every((request) => !request.review)).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { runner.pause(); await fixture.close(); }
});
