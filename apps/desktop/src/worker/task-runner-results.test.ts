import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

describe('remote result analysis', () => {
  it.each([
    { exitCode: 0, output: '/dev/sda1 145G 54G 92G 37% /', answer: '根分区使用率 37%，剩余 92G，目前空间充足。' },
    { exitCode: 1, output: 'df: cannot read table of mounted file systems', answer: '未能读取文件系统信息，暂时无法判断磁盘占用。' }
  ])('returns exit $exitCode output to the model and publishes its conclusion after the operation', async ({ exitCode, output, answer }) => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) throw new Error('Read-only df must not need model review');
      requests++;
      if (requests === 1) return { calls: [{ id: 'disk', name: 'run_remote', arguments: { hostId: 'fixture', command: 'df -h' } }] };
      if (requests !== 2) throw new Error('Unexpected repeated request');
      const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'disk');
      expect(result).toBeDefined();
      expect(fixtureMessageText(result!)).toContain(output);
      expect(fixtureMessageText(result!)).toContain(`Exit: ${exitCode}`);
      return { text: answer };
    });
    const host: RuntimeHost = { id: 'fixture', label: '本地测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'agent', status: 'connected', defaultMode: 'ai-review', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'result-analysis', goal: '检查这台服务器的磁盘占用', hostIds: [host.id], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data: () => {}, state: () => {} });
    const terminalId = terminal.open(host.id, { write: () => { throw new Error('No real terminal writes allowed'); },
      resize: () => {}, close: () => {}, onData: () => {}, onClose: () => {} }, task.id, '/home/ubuntu');
    const execute = vi.fn(async (operation: { id: string }) => ({ operationId: operation.id,
      status: exitCode === 0 ? 'succeeded' as const : 'failed' as const, exitCode, stdoutTail: output, logRef: terminalId }));
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute }, async () => terminalId,
      { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval: () => {} });
    try {
      await runner.start();
      expect(fixture.errors).toEqual([]);
      expect(requests).toBe(2);
      expect(execute).toHaveBeenCalledTimes(1);
      const completed = events.findIndex((event) => event.type === 'operation' && event.value.exitCode === exitCode);
      const analysis = events.findIndex((event) => event.type === 'task-message' && event.role === 'agent' && event.text === answer);
      expect(completed).toBeGreaterThan(-1);
      expect(analysis).toBeGreaterThan(completed);
      // Conversational analysis alone must not bypass verification or user acceptance.
      expect(events.some((event) => event.type === 'task-status' && ['ready-for-review', 'accepted'].includes(event.status))).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
