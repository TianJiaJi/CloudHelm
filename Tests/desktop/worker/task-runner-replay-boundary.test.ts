import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const task = (): TaskView => ({ id: 'replay', goal: '观察当前目录', hostIds: ['host'], localScopes: [], status: 'draft',
  provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 40, createdAt: 1, updatedAt: 1 });
const prior = (status: OperationView['status']): OperationView => ({ id: 'restart', taskId: 'replay', hostId: 'host',
  kind: 'command', readOnly: false, status, exitCode: status === 'succeeded' ? 0 : undefined,
  preview: 'systemctl restart nginx', intentKey: 'nginx-restart', createdAt: 1 });

async function opened(priorStatus?: OperationView['status']) {
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'run', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd' } }] };
    return { text: '已观察。' };
  });
  const view = task(); const terminal = new TerminalManager({ data() {}, state() {} });
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    priorStatus ? [prior(priorStatus)] : [], terminal,
    { execute: vi.fn(async (operation: { id: string }) => ({ operationId: operation.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: '/srv\n' })) },
    async () => terminal.open(host.id, { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, view.id, '/srv'),
    { event() {}, requestApproval: async () => true, cancelApproval() {} });
  // The runner's scheduler stays the authority for the protection set; the test only reads it.
  const protectedIds = () => [...(runner as unknown as { execution: { replayProtected: Set<string> } }).execution.replayProtected];
  const closed = () => (runner as unknown as { verification: { closed: boolean } }).verification.closed;
  return { fixture, view, runner, protectedIds, closed };
}

it('releases replay protection after a closed round without waiting for report wording', async () => {
  const f = await opened('succeeded');
  try {
    // A prior persisted operation is protected before the first round runs.
    expect(f.protectedIds()).toEqual(['restart']);
    await f.runner.start();
    await vi.waitFor(() => expect(f.view.status).toBe('answered'), { timeout: 15000 });
    expect(f.fixture.errors).toEqual([]);
    expect(f.closed()).toBe(true);
    f.runner.message('同一个服务再重启一次');
    // Report state never decides this: the closed round plus no unresolved outcome does.
    expect(f.protectedIds()).toEqual([]);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it('keeps protection while a previous remote outcome is still unresolved', async () => {
  const f = await opened('unknown');
  try {
    await f.runner.start(true);
    expect(f.protectedIds()).toEqual(['restart']);
    f.runner.message('同一个服务再重启一次');
    expect(f.protectedIds()).toEqual(['restart']);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});
