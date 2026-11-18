import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationExecutor, HostEnvironmentObservation } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

it('recovers an older operation through actual Pi tool calls without probing on restore or replaying the change', async () => {
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    const system = request.messages.filter((message) => ['system', 'developer'].includes(message.role)).map(fixtureMessageText).join('\n');
    expect(system).toContain('fixture-linux'); expect(system).toContain('not root authorization');
    if (requests === 1) return { calls: [{ id: 'history', name: 'query_operation_history', arguments: { hostId: 'host', query: '8080', limit: 1 } }] };
    if (requests === 2) {
      const result = JSON.parse(fixtureMessageText(request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'history')!));
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject({ operationId: 'old-port', binding: 'historical-connection',
        action: { preview: 'ufw allow 8080/tcp' }, observation: { status: 'succeeded' }, currentState: 'not-established-by-history' });
      return { calls: [{ id: 'observe', name: 'run_remote', arguments: { hostId: 'host', command: 'id -u' } }] };
    }
    expect(requests).toBe(3);
    return { text: '之前开放过8080端口；这是历史记录，不证明现在仍然开放。本次仅查询了当前登录UID，没有重复修改。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'fixture', auth: 'password',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'task', goal: '检查之前的端口操作和当前UID', hostIds: ['host'], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'paused', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
  const port: OperationView = { id: 'old-port', taskId: 'task', hostId: 'host', kind: 'command', preview: 'ufw allow 8080/tcp',
    loginAs: 'fixture', runAs: 'root', readOnly: false, status: 'succeeded', exitCode: 0, exitObserved: true, createdAt: 1,
    executionContext: { version: 1, connectionId: 'old-worker:1', terminalId: 'old-A', terminalGeneration: 1 } };
  const prior = [port, ...Array.from({ length: 20 }, (_, i): OperationView => ({ ...port, id: `query-${i}`, preview: 'df -h',
    runAs: 'fixture', readOnly: true, createdAt: 2 + i }))];
  const metadata: HostEnvironmentObservation = { version: 1, hostId: 'host', loginAs: 'fixture', connectionId: 'new-worker:1',
    status: 'observed', observedAt: Date.now(), data: { os: 'fixture-linux', distribution: 'fixture-os', version: '1',
      kernel: '1', architecture: 'aarch64', architectureFamily: 'aarch64', username: 'fixture', uid: 1000,
      loginDirectory: '/home/fixture', path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', toolPresence: {}, source: 'shell' },
    readiness: { ssh: 'connected', metadata: 'ready', execution: 'ready' } };
  const refresh = vi.fn(async () => { throw new Error('Restore/context/history must not probe'); });
  const terminal = new TerminalManager({ data: () => {}, state: () => {} });
  const execute = vi.fn(async (...[operation]: Parameters<OperationExecutor['execute']>) => ({ operationId: operation.id,
    status: 'succeeded' as const, exitCode: 0, stdoutTail: '1000\n', effects: 'none' as const }));
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const recorded: OperationView[] = [];
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: fixture.baseUrl },
    prior, terminal, { execute }, async () => terminal.open('host', { write: () => { throw new Error('No SSH input'); },
      resize() {}, close() {}, onData() {}, onClose() {} }, 'task', '/home/fixture'), {
      event: (event) => {
        if (event.type === 'operation') recorded.push(structuredClone(event.value));
        if (event.type === 'task-status' && ['answered', 'failed'].includes(event.status)) finish();
      }, requestApproval: async () => { throw new Error('Read-only history must not require approval'); }, cancelApproval() {}
    }, undefined, undefined, undefined, undefined, { snapshot: () => structuredClone(metadata), refresh });
  try {
    await runner.start(true); expect(requests).toBe(0); expect(refresh).not.toHaveBeenCalled();
    runner.preparationSnapshot(); expect(requests).toBe(0); expect(refresh).not.toHaveBeenCalled();
    runner.message('查询8080的操作历史，并读取当前UID'); await settled;
    expect(fixture.errors).toEqual([]); expect(requests).toBe(3); expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ kind: 'command', command: 'id -u' });
    expect(recorded.at(-1)).toMatchObject({ status: 'succeeded', executionContext: { version: 1, connectionId: 'new-worker:1', terminalGeneration: 1 } });
    expect(prior[0]).toEqual(port); expect(refresh).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});
