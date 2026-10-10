import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
import { hasUnresolvedOperation } from './recovery-context.js';

it('does not treat a classified read-only unknown as a pending remote write', () => {
  const query = { id: 'old', taskId: 'previous', hostId: 'fixture', kind: 'command' as const,
    preview: 'df -h', status: 'unknown' as const, createdAt: 1, readOnly: true };
  expect(hasUnresolvedOperation([query])).toBe(false);
  expect(hasUnresolvedOperation([{ ...query, readOnly: false }])).toBe(true);
});

describe('remote result analysis', () => {
  it('keeps the Agent running after a pre-dispatch host lock and permits read-only verification', async () => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) throw new Error('Unexpected review');
      requests++;
      if (requests === 1) return { calls: [{ id: 'write', name: 'run_remote', arguments: {
        hostId: 'fixture', command: 'mkdir -p /tmp/cloudhelm-check'
      } }] };
      if (requests === 2) {
        const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'write');
        expect(fixtureMessageText(result!)).toContain('Effects: none');
        return { calls: [{ id: 'inspect', name: 'run_remote', arguments: { hostId: 'fixture', command: 'docker ps -a' } }] };
      }
      return { text: '已核验只读查询，原写入未发送。' };
    });
    const host: RuntimeHost = { id: 'fixture', label: '本地测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'agent', status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'blocked-write', goal: '检查状态', hostIds: [host.id], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data: () => {}, state: () => {} });
    const terminalId = terminal.open(host.id, { write: () => {}, resize: () => {}, close: () => {}, onData: () => {}, onClose: () => {} }, task.id, '/home/ubuntu');
    const execute = vi.fn(async (operation: ProposedOperation) => operation.kind === 'command' && operation.command.startsWith('mkdir')
      ? { operationId: operation.id, status: 'failed' as const, effects: 'none' as const,
        failureKind: 'unresolved-prior-operation' as const, stdoutTail: 'Original operation needs verification' }
      : { operationId: operation.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: 'CONTAINER ID', logRef: terminalId });
    const events: Parameters<TaskSignals['event']>[0][] = [];
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute }, async () => terminalId,
      { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval: () => {} });
    try {
      await runner.start();
      expect(fixture.errors).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]?.[0]).toMatchObject({ command: 'docker ps -a' });
      expect(events.some((event) => event.type === 'task-status' && event.status === 'paused'
        && event.summary?.includes('尚未核验的远端操作'))).toBe(false);
    } finally { await fixture.close(); }
  });

  it('binds a follow-up Docker query to the latest request and executes it without approval', async () => {
    let requests = 0;
    const fixture = await openAiFixture(async (request) => {
      if (request.review) throw new Error('Docker listing must not need AI review');
      requests++;
      if (requests === 1) return { text: '磁盘检查完毕。' };
      if (requests === 2) return { calls: [{ id: 'docker', name: 'run_remote', arguments: {
        hostId: 'fixture', command: 'docker ps -a'
      } }] };
      return { text: 'Docker 容器列表已返回。' };
    });
    const host: RuntimeHost = { id: 'fixture', label: '本地测试', address: '192.0.2.1', port: 22, username: 'ubuntu',
      auth: 'agent', status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
    const task: TaskView = { id: 'follow-up', goal: '检查磁盘占用', hostIds: [host.id], localScopes: [],
      provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 5, createdAt: 1, updatedAt: 1 };
    const terminal = new TerminalManager({ data: () => {}, state: () => {} });
    const terminalId = terminal.open(host.id, { write: () => {}, resize: () => {}, close: () => {}, onData: () => {}, onClose: () => {} }, task.id, '/home/ubuntu');
    const execute = vi.fn(async (operation: { id: string }, _fingerprint: string, _signal?: AbortSignal, _options?: { readOnly?: boolean }) => ({ operationId: operation.id,
      status: 'succeeded' as const, exitCode: 0, effects: 'none' as const, stdoutTail: 'CONTAINER ID', logRef: terminalId }));
    const approval = vi.fn(async () => false);
    const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
      [], terminal, { execute }, async () => terminalId,
      { event: () => {}, requestApproval: approval, cancelApproval: () => {} });
    try {
      await runner.start();
      runner.message('查看 Docker 服务');
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ command: 'docker ps -a', scope: { goal: '查看 Docker 服务' } });
      expect(execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: true });
      expect(approval).not.toHaveBeenCalled();
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

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
