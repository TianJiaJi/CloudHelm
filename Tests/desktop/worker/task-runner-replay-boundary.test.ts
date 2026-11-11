import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const task = (): TaskView => ({ id: 'triangle', goal: '重启服务并检查结果', hostIds: ['host'], localScopes: [], status: 'draft',
  provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 });
const prior = (status: OperationView['status']): OperationView => ({ id: 'restart', taskId: 'triangle', hostId: 'host',
  kind: 'command', readOnly: false, status, exitCode: status === 'succeeded' ? 0 : undefined,
  preview: 'systemctl restart nginx', intentKey: 'nginx-restart', createdAt: 1 });

async function opened(status: OperationView['status']) {
  const fixture = await openAiFixture(async () => ({ text: '按用户要求继续。' }));
  const view = task(); const terminal = new TerminalManager({ data() {}, state() {} });
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    [prior(status)], terminal, { execute: vi.fn() }, async () => { throw new Error('No terminal needed'); },
    { event() {}, requestApproval: async () => false, cancelApproval() {} });
  await runner.start(true);
  Object.assign(runner, { status: 'answered', needsRecovery: false });
  return { fixture, view, runner, protectedIds: () => [...(runner as unknown as { replayProtected: Set<string> }).replayProtected] };
}

it('lets an explicit new request re-review a settled operation without a verified report', async () => {
  const f = await opened('succeeded');
  try {
    expect(f.protectedIds()).toEqual(['restart']);
    f.runner.message('同一个服务再重启一次');
    expect(f.protectedIds()).toEqual([]);
    await vi.waitFor(() => expect(f.view.status).toBe('answered'), { timeout: 15000 });
    expect(f.fixture.errors).toEqual([]);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it('keeps replay protection while the previous remote outcome is still unresolved', async () => {
  const f = await opened('unknown');
  try {
    f.runner.message('同一个服务再重启一次');
    expect(f.protectedIds()).toEqual(['restart']);
    await vi.waitFor(() => expect(f.fixture.requests).toHaveLength(1), { timeout: 15000 });
    expect(f.protectedIds()).toEqual(['restart']);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});
