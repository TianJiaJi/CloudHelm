import { describe, expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { RawTerminal } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner, type TaskSignals } from './task-runner.js';
import { openAiFixture } from './openai-sse-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlTerminal implements RawTerminal {
  private exited?: (code: number) => void;
  private closed?: () => void;
  commands: string[] = [];
  writes: string[] = [];
  constructor(private readonly completeImmediately: boolean) {}
  async execute(command: string): Promise<void> {
    this.commands.push(command);
    if (this.completeImmediately) queueMicrotask(() => this.complete());
  }
  complete(): void { this.exited?.(0); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  close(): void { this.closed?.(); }
  onData(): void {}
  onClose(listener: () => void): void { this.closed = listener; }
}

async function setup(completeImmediately = true) {
  const control: { openBarrier?: Promise<void>; responseBarrier?: Promise<void> } = {};
  let requests = 0;
  const fixture = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'disk', name: 'run_remote', arguments: { hostId: 'host', command: 'df -h' } }] };
    await control.responseBarrier;
    return { text: '已经核验当前状态。' };
  });
  const host: RuntimeHost = { id: 'host', label: '测试主机', address: '192.0.2.1', port: 22, username: 'ubuntu', auth: 'agent',
    status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
  const task: TaskView = { id: 'control-test', goal: '检查磁盘占用', hostIds: [host.id], localScopes: [], provider: 'cloudhelm-custom',
    modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const terminal = new TerminalManager({ data() {}, state() {}, completed: (result) => runner.recordRemoteResult(result) });
  const sessions: Array<{ id: string; channel: ControlTerminal }> = [];
  const openTerminal = vi.fn(async () => {
    const channel = new ControlTerminal(completeImmediately);
    const id = terminal.open(host.id, channel, task.id, '/home/ubuntu');
    sessions.push({ id, channel });
    await control.openBarrier;
    return id;
  });
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'dummy', baseUrl: fixture.baseUrl },
    [], terminal, terminal, openTerminal,
    { event: (event) => events.push(structuredClone(event)), requestApproval: async () => false, cancelApproval() {} });
  return { runner, terminal, sessions, events, openTerminal, control, fixture, requests: () => requests };
}

describe('stop and explicit continuation', () => {
  it('permits idle terminal input without prompting and ignores stale stop actions after completion', async () => {
    const f = await setup();
    try {
      await f.runner.start();
      const id = f.sessions[0]!.id;
      f.runner.terminalInput(id, 'pwd\n');
      f.runner.stopOperation();
      expect(f.requests()).toBe(2);
      expect(f.sessions[0]!.channel.writes).toEqual(['pwd\n']);
      expect(f.events.filter((event) => event.type === 'task-message' && event.interruption)).toHaveLength(0);
      expect(f.terminal.isAgentOwner(id)).toBe(false);
    } finally { await f.fixture.close(); }
  });

  it.each(['ctrl-c', 'stop-button', 'terminal-close'] as const)('records %s as user intent, blocks input while running, and reports it only on the next explicit turn', async (source) => {
    const f = await setup(false);
    try {
      const running = f.runner.start();
      await vi.waitFor(() => expect(f.sessions[0]?.channel.commands).toEqual(['df -h']), { timeout: 15000 });
      const id = f.sessions[0]!.id;
      expect(() => f.runner.terminalInput(id, 'pwd\n')).toThrow('先停止');
      expect(f.sessions[0]!.channel.writes).toEqual([]);
      if (source === 'ctrl-c') f.runner.terminalInput(id, '\u0003'); else f.runner.stopOperation(source);
      f.runner.stopOperation(source); // Repeated clicks cannot inject duplicate controls or requests.
      await running;
      expect(f.requests()).toBe(1);
      expect(f.sessions[0]!.channel.writes).toEqual(source === 'terminal-close' ? [] : ['\u0003']);
      expect(() => f.runner.terminalInput(id, 'pwd\n')).toThrow('等待命令退出');
      expect(f.events.filter((event) => event.type === 'task-message' && event.interruption)).toHaveLength(1);
      expect(f.events.filter((event) => event.type === 'operation').at(-1)).toMatchObject({ value: { status: 'unknown', interruption: { source } } });
      f.sessions[0]!.channel.complete();
      expect(f.events.filter((event) => event.type === 'operation').at(-1)).toMatchObject({ value: { status: 'succeeded', exitCode: 0, interruption: { source } } });
      f.runner.terminalInput(id, 'pwd\n');
      expect(f.requests()).toBe(1);
      f.runner.message('请核验状态，不要重试');
      await vi.waitFor(() => expect(f.requests()).toBe(2), { timeout: 15000 });
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain('CloudHelm user interruption');
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain(source);
      expect(JSON.stringify(f.fixture.requests[1]!.messages)).toContain('Do not automatically retry');
      expect(f.sessions.flatMap((session) => session.channel.commands)).toEqual(['df -h']);
    } finally { f.runner.pause(); await f.fixture.close(); }
  });

  it('coalesces explicit resume requests and cancels a replacement terminal opened during stop', async () => {
    const f = await setup(false);
    const opening = deferred();
    try {
      const running = f.runner.start();
      await vi.waitFor(() => expect(f.sessions[0]?.channel.commands).toEqual(['df -h']), { timeout: 15000 });
      f.runner.stopOperation(); await running;
      f.sessions[0]!.channel.complete();
      f.control.openBarrier = opening.promise;
      const resuming = f.runner.resume();
      expect(f.runner.resume()).toBe(resuming);
      await vi.waitFor(() => expect(f.sessions).toHaveLength(2), { timeout: 15000 });
      f.runner.pause(); opening.resolve(); await resuming;
      expect(f.requests()).toBe(1);
      expect(f.terminal.currentGeneration(f.sessions[1]!.id)).toBe(-1);
      expect(f.events.some((event) => event.type === 'terminal-replaced')).toBe(false);
    } finally { opening.resolve(); f.runner.pause(); await f.fixture.close(); }
  });
});
