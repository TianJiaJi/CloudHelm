import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { ConnectionLossRecord, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture, fixtureMessageText } from './openai-sse-fixture.js';

/** Channel whose dispatched command holds until the test observes the late exit. */
class HeldTerminal implements RawTerminal {
  private exited?: (code: number) => void;
  private closed?: () => void;
  readonly commands: string[] = [];
  async execute(command: string): Promise<void> { this.commands.push(command); }
  complete(): void { this.exited?.(0); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  write(): void {}
  resize(): void {}
  close(): void { this.closed?.(); }
  onData(): void {}
  onClose(listener: () => void): void { this.closed = listener; }
}

const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
  status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
type WorkerEvent = Parameters<TaskSignals['event']>[0];
type TaskMessageEvent = Extract<WorkerEvent, { type: 'task-message' }>;
const systemMessages = (events: WorkerEvent[]) =>
  events.filter((event): event is TaskMessageEvent => event.type === 'task-message' && event.role === 'system');

it('records in-flight work as handed off or unclear and never revises the loss-time record', async () => {
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'disk', name: 'run_remote', arguments: { hostId: 'host', command: 'df -h' } }] };
    return { text: '已核验磁盘状态。' };
  });
  const task: TaskView = { id: 'loss-inflight', goal: '检查磁盘占用', hostIds: [host.id], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  let channel!: HeldTerminal;
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, terminal, async () => {
      channel = new HeldTerminal();
      return terminal.open(host.id, channel, task.id, '/home/ubuntu');
    }, { event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {} });
  try {
    const running = runner.start();
    await vi.waitFor(() => expect(channel.commands).toEqual(['df -h']), { timeout: 15_000 });
    runner.recordConnectionLoss('host');
    const losses = events.filter((event) => event.type === 'connection-loss');
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ taskId: task.id, value: { version: 1, hostId: 'host',
      operations: [{ operationId: expect.any(String), classification: 'handed-off-or-unclear', readOnly: true }] } });
    expect(systemMessages(events).map((event) => event.text))
      .toEqual(['与主机 host 的连接中断。断线时共 1 项在途或待发操作：未交接 0、已观察完成 0、已交接或边界不明 1。'
        + '已交接或边界不明的操作不会自动重放，重连后先核验。重连成功不代表断线前的操作已完成。']);
    // One physical loss reaches both the user path and the transport callback; recorded once.
    runner.recordConnectionLoss('host');
    expect(events.filter((event) => event.type === 'connection-loss')).toHaveLength(1);
    channel.complete();
    await running;
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
    // The late observed exit updates the ledger but never rewrites loss-time evidence.
    expect(runner.task.connectionLosses?.[0]?.operations[0]).toMatchObject({ classification: 'handed-off-or-unclear' });
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

it('reports persisted loss records once when the rebuilt connection resumes', async () => {
  const loss: ConnectionLossRecord = { version: 1, hostId: 'host', lostAt: 400,
    operations: [{ operationId: 'op-lost', classification: 'handed-off-or-unclear' }] };
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    const body = request.messages.map(fixtureMessageText).join('\n');
    if (requests === 1) {
      expect(body).toContain('CloudHelm reconnected after a connection loss');
      expect(body).toContain('"operationId":"op-lost"');
      expect(body).toContain('handed-off-or-unclear operations must never be re-run automatically');
      expect(body).not.toContain('CloudHelm resume:');
      return { text: '已在重连后核验断线时未决的操作。' };
    }
    // The resume report stays in history exactly once; the same loss is never re-injected.
    expect(body.split('CloudHelm reconnected after a connection loss').length - 1).toBe(1);
    return { text: '继续完成剩余工作。' };
  });
  const task: TaskView = { id: 'loss-resume', goal: '检查磁盘占用', hostIds: [host.id], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'paused', resumeReason: 'interrupted', connectionLosses: [structuredClone(loss)],
    requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, terminal, async () => terminal.open(host.id, new HeldTerminal(), task.id, '/home/ubuntu'),
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => true, cancelApproval() {} });
  try {
    await runner.start(true);
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'paused', resumeReason: 'interrupted' });
    await runner.resume();
    expect(events.filter((event) => event.type === 'task-status').at(-1)).toMatchObject({ status: 'answered' });
    runner.message('继续完成');
    await vi.waitFor(() => expect(requests).toBe(2), { timeout: 15_000 });
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
