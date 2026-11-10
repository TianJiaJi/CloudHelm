import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
class Channel extends EventEmitter {
  stderr = new EventEmitter();
  write = vi.fn();
  end = vi.fn();
  close(): void { this.emit('close'); }
  event(value: unknown): void { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(prepare?: () => Promise<string>) {
  const analysis = await new BashAnalyzer().analyze('sleep 30');
  vi.spyOn(BashAnalyzer.prototype, 'analyze').mockResolvedValue(analysis);
  vi.useFakeTimers();
  const channel = new Channel(), openPipe = vi.fn(async () => channel), remove = vi.fn(async () => {});
  const terminal = new SshCommandTerminal({ connectionGeneration: () => 1,
    prepareCommandProgram: prepare ?? (async () => '/tmp/fixed.py'), removeCommandProgram: remove, openPipe } as unknown as CommandTransport, 'host');
  const closed = vi.fn(), exited = vi.fn(), failure = vi.fn();
  terminal.onClose(closed); terminal.onExit(exited); terminal.onExecutionFailure(failure);
  return { terminal, channel, openPipe, remove, closed, exited, failure };
}
it('bounds stalled preparation and never dispatches a late business header', async () => {
  let finish!: (path: string) => void;
  const preparation = new Promise<string>((resolve) => { finish = resolve; }), f = await fixture(() => preparation);
  const pending = f.terminal.execute('sleep 30', '/', () => true), failed = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(180000); await failed;
  expect(f.closed).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
  finish('/tmp/fixed.py'); await vi.advanceTimersByTimeAsync(0);
  expect(f.openPipe).not.toHaveBeenCalled(); expect(f.remove).toHaveBeenCalledOnce();
  expect(f.exited).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('treats missing start evidence as unknown, not exit or no effects', async () => {
  const f = await fixture(); await f.terminal.execute('sleep 30', '/', () => true);
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.closed).toHaveBeenCalledOnce(); expect(f.exited).toHaveBeenCalledWith(undefined);
  expect(f.failure).not.toHaveBeenCalled(); expect(f.channel.write).toHaveBeenCalledOnce();
  f.channel.event({ type: 'process-started', pid: 42 });
  expect(f.channel.write).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('does not impose the startup deadline on an observed running process', async () => {
  const f = await fixture(); await f.terminal.execute('sleep 30', '/', () => true);
  f.channel.event({ type: 'process-started', pid: 42 });
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.closed).not.toHaveBeenCalled(); expect(f.exited).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); f.terminal.close();
});
it('does not reclaim a human-owned pending process when the old startup deadline passes', async () => {
  const f = await fixture(); await f.terminal.execute('sleep 30', '/', () => true);
  f.terminal.takeOver(); await vi.advanceTimersByTimeAsync(180000);
  expect(f.closed).not.toHaveBeenCalled(); expect(f.exited).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); f.terminal.close();
});
