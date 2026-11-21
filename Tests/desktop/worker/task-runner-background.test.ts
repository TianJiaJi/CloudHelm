import { expect, it, vi } from 'vitest';
import { HostSerialExecutor, TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

class BackgroundTerminal implements RawTerminal {
  private started = (_event: { pid: number }) => {};
  private exited = (_code: number | undefined) => {};
  private closed = () => {};
  private data = (_data: string) => {};
  authorized?: () => boolean;
  commands: string[] = []; writes: string[] = []; interrupts: number[] = [];
  async interrupt(pid: number): Promise<'sent'> { this.interrupts.push(pid); return 'sent'; }
  async execute(command: string, _cwd: string, authorized: () => boolean): Promise<void> {
    this.commands.push(command); this.authorized = authorized;
    queueMicrotask(() => {
      this.started({ pid: command === 'df -h' ? 43 : 42 });
      if (command === 'df -h') { this.data('synthetic disk observation'); this.complete(0); }
    });
  }
  onProcessStarted(listener: typeof this.started): void { this.started = listener; }
  onExit(listener: typeof this.exited): void { this.exited = listener; }
  onClose(listener: typeof this.closed): void { this.closed = listener; }
  onData(listener: typeof this.data): void { this.data = listener; }
  complete(code: number): void { this.exited(code); }
  write(value: string): void { this.writes.push(value); }
  resize(): void {}
  close(): void { this.closed(); }
}

async function setup(stop = false, commitOperation?: TaskSignals['commitOperation']) {
  let requests = 0, jobId: string | undefined;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'service', name: 'run_remote', arguments: {
      hostId: 'host', command: 'python3 -m http.server 8080', background: true } }] };
    if (requests === 2) return { calls: [{ id: 'diagnostic', name: 'run_remote', arguments: { hostId: 'host', command: 'df -h' } }] };
    if (stop && requests === 3) return { calls: [{ id: 'stop', name: 'stop_remote_job', arguments: { hostId: 'host', jobId } }] };
    return { text: stop ? '停止请求已发送，尚未确认退出。' : '临时进程已启动，磁盘已检查；进程是否健康尚未验证。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'synthetic', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'password',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'background-task', goal: '启动临时服务，并在独立终端检查磁盘', hostIds: ['host'], localScopes: [],
    provider: 'cloudhelm-custom', modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [], operations = new Map<string, OperationView>();
  const sessions: Array<{ id: string; channel: BackgroundTerminal }> = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => {
    serial.observe('host', result); runner.recordRemoteResult(result);
  } });
  const serial = new HostSerialExecutor(terminal);
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, serial, async () => {
      const channel = new BackgroundTerminal(), id = terminal.open('host', channel, task.id, '/home/ubuntu');
      sessions.push({ id, channel }); return id;
    }, { commitOperation, event: (event) => {
      events.push(structuredClone(event));
      if (event.type === 'operation') {
        operations.set(event.value.id, structuredClone(event.value));
        if (event.value.executionJob) jobId = event.value.executionJob.jobId;
      }
    }, requestApproval: async () => true, cancelApproval() {} });
  return { fixture, runner, sessions, operations, terminal, serial, task, requests: () => requests };
}

it('returns a normal answer with a live background A and independent diagnostic B, without stdin injection or automatic wakeups', async () => {
  const f = await setup();
  try {
    await f.runner.start();
    expect(f.requests()).toBe(3); expect(f.task.status).toBe('answered'); expect(f.sessions).toHaveLength(2);
    const nextFrame = JSON.stringify(f.fixture.requests[1]!.messages);
    expect(nextFrame).toContain('backend-transport-observation'); expect(nextFrame).toContain('not-established');
    expect(f.sessions[0]!.channel.commands).toEqual(['python3 -m http.server 8080']);
    expect(f.sessions[1]!.channel.commands).toEqual(['df -h']);
    expect(f.sessions.flatMap((entry) => entry.channel.writes)).toEqual([]);
    const service = [...f.operations.values()].find((op) => op.executionJob)!;
    expect(service).toMatchObject({ status: 'running', executionJob: { status: 'running', pid: 42, exitObserved: false } });
    expect(f.terminal.hasPending(f.sessions[0]!.id)).toBe(true);
    expect(f.sessions[0]!.channel.authorized?.()).toBe(true);
    expect(f.serial.canReconcile('host', service.id)).toBe(false);
    f.sessions[0]!.channel.complete(0);
    await vi.waitFor(() => expect(f.operations.get(service.id)).toMatchObject({ status: 'succeeded', executionJob: { status: 'exited', exitCode: 0 } }));
    expect(f.requests()).toBe(3); expect(f.task.status).toBe('answered');
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it('reviews a bound stop request without executing kill as shell or claiming target exit', async () => {
  const f = await setup(true);
  try {
    await f.runner.start();
    expect(f.requests()).toBe(4); expect(f.task.status).toBe('answered');
    expect(f.sessions[0]!.channel.interrupts).toEqual([42]);
    expect(f.sessions.flatMap((entry) => entry.channel.commands)).toEqual(['python3 -m http.server 8080', 'df -h']);
    expect(f.sessions.flatMap((entry) => entry.channel.writes)).toEqual([]);
    const service = [...f.operations.values()].find((operation) => operation.executionJob)!;
    const control = [...f.operations.values()].find((operation) => operation.processControl)!;
    expect(service).toMatchObject({ toolCallId: 'service' });
    expect(service.executionJob).toMatchObject({ status: 'stop-requested', exitObserved: false });
    expect(control).toMatchObject({ status: 'succeeded', exitObserved: false, toolCallId: 'stop',
      processControl: { delivery: 'sent', targetOperationId: service.id } });
    expect(typeof control.delegationId).toBe('string');
    expect(control.delegationId).not.toBe(service.delegationId);
    expect(f.sessions[0]!.channel.authorized?.()).toBe(false);
    expect(f.terminal.hasPending(f.sessions[0]!.id)).toBe(true);
    f.sessions[0]!.channel.complete(130);
    await vi.waitFor(() => expect(f.operations.get(service.id)?.executionJob).toMatchObject({ exitObserved: true, exitCode: 130 }));
    expect(f.requests()).toBe(4); expect(f.serial.hasPendingOrUnresolved('host')).toBe(true);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it.each(['start', 'stop'] as const)('does not dispatch %s when its durable decision is unconfirmed', async (phase) => {
  const commit = vi.fn(async (operation: OperationView) => {
    if (operation.status === 'running' && (phase === 'start' ? operation.executionJob : operation.processControl))
      throw new Error('synthetic storage unavailable');
  });
  const f = await setup(phase === 'stop', commit);
  try {
    await f.runner.start();
    expect(commit).toHaveBeenCalled();
    expect(f.sessions.flatMap((entry) => entry.channel.interrupts)).toEqual([]);
    if (phase === 'start') expect(f.sessions.flatMap((entry) => entry.channel.commands)).not.toContain('python3 -m http.server 8080');
    else {
      expect(f.sessions[0]!.channel.commands).toEqual(['python3 -m http.server 8080']);
      expect(f.sessions[0]!.channel.authorized?.()).toBe(true);
      expect([...f.operations.values()].find((op) => op.executionJob)?.executionJob?.stopRequestId).toBeUndefined();
    }
  } finally { f.runner.dispose(); await f.fixture.close(); }
});

it('model pause does not revoke an already-started operation or pretend the process exited', async () => {
  const f = await setup();
  try {
    await f.runner.start(); f.runner.pause();
    const service = [...f.operations.values()].find((op) => op.executionJob)!;
    expect(f.terminal.hasPending(f.sessions[0]!.id)).toBe(true);
    expect(f.sessions[0]!.channel.authorized?.()).toBe(true);
    expect(f.operations.get(service.id)?.executionJob?.exitObserved).toBe(false);
    f.sessions[0]!.channel.complete(1);
    await vi.waitFor(() => expect(f.operations.get(service.id)?.executionJob?.exitObserved).toBe(true));
    expect(f.requests()).toBe(3);
    expect(f.serial.hasPendingOrUnresolved('host')).toBe(true);
  } finally { f.runner.dispose(); await f.fixture.close(); }
});
