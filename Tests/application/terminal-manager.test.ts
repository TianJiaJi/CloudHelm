import { describe, expect, it, vi } from 'vitest';
import type { ProposedOperation, RawTerminal } from '@cloudhelm/core';
import { CommandNotStartedError, operationFingerprint } from '@cloudhelm/core';
import { TerminalManager } from '../../packages/application/src/terminal-manager.js';

class FakeTerminal implements RawTerminal {
  writes: string[] = [];
  private data?: (text: string) => void;
  private closed?: () => void;
  private exited?: (code: number | undefined) => void;
  private started?: (event: { pid: number }) => void;
  onProcessStarted(listener: (event: { pid: number }) => void): void { this.started = listener; }
  start(pid: number): void { this.started?.({ pid }); }
  commands: Array<{ command: string; cwd: string }> = [];
  async execute(command: string, cwd: string): Promise<void> { this.commands.push({ command, cwd }); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  complete(code = 0): void { this.exited?.(code); }
  write(text: string): void { this.writes.push(text); }
  resize(): void {}
  close(): void { this.closed?.(); }
  onData(listener: (text: string) => void): void { this.data = listener; }
  onClose(listener: () => void): void { this.closed = listener; }
  emit(text: string): void { this.data?.(text); }
}

function operation(id: string, generation: number): ProposedOperation {
  return { id, kind: 'command', command: 'echo hi', scope: {
    taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'replace', terminalGeneration: generation,
    policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy'
  } };
}

describe('real PTY ownership', () => {
  it('does not let a late model abort overwrite human ownership or its generation', async () => {
    const channel = new FakeTerminal(), state = vi.fn(), controller = new AbortController();
    const manager = new TerminalManager({ data() {}, state });
    const id = manager.open('host', channel, 'task'), proposed = operation('handover', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const pending = manager.execute(proposed, operationFingerprint(proposed), controller.signal);
    manager.takeOver(id);
    const generation = manager.currentGeneration(id);
    expect((await pending).status).toBe('handed-over');
    controller.abort();
    expect(manager.currentGeneration(id)).toBe(generation);
    expect(manager.stateOf(id)).toBe('human');
    expect(state).toHaveBeenLastCalledWith(id, 'human');
    channel.complete();
  });

  it('binds process observations to the pending operation, and does not settle it on startup', async () => {
    const channel = new FakeTerminal(), processStarted = vi.fn(), observed = vi.fn();
    const manager = new TerminalManager({ data() {}, state() {}, processStarted });
    const id = manager.open('host', channel, 'task');
    channel.start(1); expect(processStarted).not.toHaveBeenCalled();
    const proposed = operation('one', manager.currentGeneration(id)); proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed), undefined, { onProcessStarted: observed });
    channel.start(42);
    expect(processStarted).toHaveBeenCalledExactlyOnceWith(id, 'one', 1, 42);
    expect(observed).toHaveBeenCalledExactlyOnceWith({ pid: 42 }); expect(manager.hasPending(id)).toBe(true);
    manager.takeOver(id); channel.start(43);
    expect(observed).toHaveBeenCalledTimes(1); expect((await result).status).toBe('handed-over');
    channel.complete();
  });
  it('rechecks the lease after synchronous startup observers and rejects revoked policy', async () => {
    const channel = new FakeTerminal(), observed = vi.fn(); let authorized = true;
    const manager = new TerminalManager({ data() {}, state() {}, processStarted() { authorized = false; } });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id)); proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed), undefined,
      { isAuthorized: () => authorized, onProcessStarted: observed });
    channel.start(42); channel.start(43); expect(observed).not.toHaveBeenCalled();
    channel.complete(); await result;
  });

  it.each(['hello', `${'🙂'.repeat(40000)}\n`])('reports authoritative redacted-output truncation without split surrogate pairs', async (output) => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('capture', manager.currentGeneration(id)); proposed.scope.terminalId = id;
    const pending = manager.execute(proposed, operationFingerprint(proposed));
    channel.emit(output); channel.complete();
    const result = await pending;
    expect(result).toMatchObject({ outputCapture: { totalChars: output.length,
      tailChars: result.stdoutTail.length, truncated: output.length > result.stdoutTail.length } });
    expect(result.stdoutTail.length).toBeLessThanOrEqual(16384);
    expect(Buffer.from(result.stdoutTail, 'utf8').toString('utf8')).toBe(result.stdoutTail);
  });

  it('blocks typing until the backend releases the idle session and invalidates old grants', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    expect(() => manager.input(id, 'pwd\n', true)).toThrow('先停止');
    expect(channel.writes).toEqual([]);
    manager.releaseIdle(id);
    manager.input(id, 'pwd\n', true);
    await expect(manager.execute(proposed, operationFingerprint(proposed))).rejects.toThrow('authorization expired');
    expect(channel.writes).toEqual(['pwd\n']);
  });

  it('runs the original command directly and records the process exit result', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('one', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed));
    expect(channel.commands).toEqual([{ command: 'echo hi', cwd: '/srv/app' }]);
    expect(channel.writes).toEqual([]);
    channel.emit('hi\r\n'); channel.complete();
    expect((await result).status).toBe('succeeded');
  });

  it('keeps observing process completion after human takeover', async () => {
    const channel = new FakeTerminal();
    const manager = new TerminalManager({ data() {}, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('takeover', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    manager.takeOver(id);
    const handedOver = await running;
    expect(handedOver.status).toBe('handed-over');
    expect(handedOver.remoteCompletion).toBeDefined();
    channel.complete();
    expect(await handedOver.remoteCompletion).toBe('exited');
  });

  it('sends no wrappers or status markers and preserves literal output', async () => {
    const channel = new FakeTerminal();
    const data: Array<{ text: string; operationId?: string }> = [];
    const manager = new TerminalManager({ data(_id, text, operationId) { data.push({ text, operationId }); }, state() {} });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('clean', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const result = manager.execute(proposed, operationFingerprint(proposed));
    expect(channel.commands).toEqual([{ command: 'echo hi', cwd: '/srv/app' }]);
    expect(channel.writes).toEqual([]);
    channel.emit('hi\r\n'); channel.complete();
    expect((await result).stdoutTail).toBe('hi\r\n');
    expect(data.filter((event) => event.operationId).map((event) => event.text).join('')).toBe('hi\r\n');
    expect(data.map((event) => event.text).join('')).toBe('$ echo hi\r\nhi\r\n');
  });

  it('invalidates a running Agent operation when its terminal is closed', async () => {
    const channel = new FakeTerminal();
    const states: string[] = [];
    const manager = new TerminalManager({ data() {}, state(_id, owner) { states.push(owner); } });
    const id = manager.open('host', channel, 'task');
    const proposed = operation('closing', manager.currentGeneration(id));
    proposed.scope.terminalId = id;
    const running = manager.execute(proposed, operationFingerprint(proposed));
    manager.close(id);
    const result = await running;
    expect(result.status).toBe('unknown');
    expect(await result.remoteCompletion).toBe('unknown');
    expect(manager.currentGeneration(id)).toBe(-1);
    expect(states).toEqual(['agent', 'suspended', 'closed']);
  });
});

it('does not leave an unresolved operation when preflight confirms no dispatch', async () => {
  const channel = new FakeTerminal();
  channel.execute = async () => { throw new CommandNotStartedError('Python 3 unavailable'); };
  const manager = new TerminalManager({ data() {}, state() {} });
  const id = manager.open('host', channel, 'task');
  const proposed = operation('preflight', manager.currentGeneration(id)); proposed.scope.terminalId = id;
  expect(await manager.execute(proposed, operationFingerprint(proposed))).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unsupported' });
  expect(manager.pendingOperations('task')).toEqual([]);
});
