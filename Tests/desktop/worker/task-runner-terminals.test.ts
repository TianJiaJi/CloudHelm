import { expect, it, vi } from 'vitest';
import { HostSerialExecutor, TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const task = (): TaskView => ({ id: 'terminal', goal: '观察当前目录', hostIds: ['host'], localScopes: [], status: 'draft',
  provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 20, createdAt: 1, updatedAt: 1 });

async function opened(prior: OperationView[] = []) {
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'run', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd' } }] };
    return { text: '已观察当前目录。' };
  });
  const view = task(); const terminal = new TerminalManager({ data() {}, state() {} });
  const openedIds: string[] = [];
  const execute = vi.fn(async (operation: { id: string }) => ({ operationId: operation.id,
    status: 'succeeded' as const, exitCode: 0, stdoutTail: '/srv\n' }));
  const runner = new TaskRunner(view, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: fixture.baseUrl },
    prior, terminal, new HostSerialExecutor({ execute }), async () => {
      const id = terminal.open(host.id, { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, view.id, '/srv');
      openedIds.push(id); return id;
    }, { event() {}, requestApproval: async () => true, cancelApproval() {} });
  return { fixture, view, terminal, runner, openedIds };
}

it('does not turn the agent terminal into a human shell when the round finishes', async () => {
  const f = await opened();
  try {
    await f.runner.start();
    await vi.waitFor(() => expect(f.view.status).toBe('answered'), { timeout: 15000 });
    expect(f.fixture.errors).toEqual([]);
    expect(f.openedIds).toHaveLength(1);
    // Being paused/answered is not an implicit handover of the SSH channel.
    expect(f.terminal.stateOf(f.openedIds[0]!)).toBe('agent');
    expect(f.terminal.isAgentOwner(f.openedIds[0]!)).toBe(true);
    // The user typing is the explicit takeover that transfers the channel.
    f.runner.terminalInput(f.openedIds[0]!, 'pwd\r');
    expect(f.terminal.stateOf(f.openedIds[0]!)).toBe('human');
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it('interrupts only the command running in that terminal', async () => {
  const f = await opened();
  try {
    await f.runner.start();
    await vi.waitFor(() => expect(f.view.status).toBe('answered'), { timeout: 15000 });
    const id = f.openedIds[0]!;
    f.runner.terminalInput(id, 'pwd\r');
    // A completed round has no pending operation: Ctrl+C must not fabricate a stop.
    expect(() => f.runner.terminalInput(id, '\u0003')).not.toThrow();
    expect(f.terminal.pendingOperations(f.view.id)).toEqual([]);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});
