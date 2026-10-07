import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, type InputRequest, type ProposedOperation, type RawTerminal } from '@cloudhelm/core';
import type { SshTransport } from '@cloudhelm/adapters';
import { OperationInputBridge } from './operation-input-bridge.js';

class FakeTerminal implements RawTerminal {
  writes: string[] = [];
  commands: string[] = [];
  answers: Array<{ id: string; answer: string | null }> = [];
  private listener?: (data: string) => void;
  private exited?: (code: number | undefined) => void;
  private authentication?: (challenge: { id: string; prompt?: string }) => void;
  private waiting?: string;
  async execute(command: string): Promise<void> { this.commands.push(command); }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.authentication = listener; }
  answerAuthentication(id: string, answer: string | null): boolean {
    if (this.waiting !== id || (answer !== null && /[\r\n\u0000]/u.test(answer))) return false;
    this.answers.push({ id, answer }); this.waiting = undefined; return true;
  }
  challenge(id: string): void { this.waiting = id; this.authentication?.({ id, prompt: 'sudo' }); }
  complete(code = 0): void { this.waiting = undefined; this.exited?.(code); }
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  close(): void {}
  onData(listener: (data: string) => void): void { this.listener = listener; }
  onClose(): void {}
  emit(data: string): void { this.listener?.(data); }
}

function fixture(command = 'sudo apt install docker.io') {
  const channel = new FakeTerminal();
  const terminal = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminal.open('host', channel, 'task');
  const requests: InputRequest[] = [];
  const coordinator = new InteractionCoordinator(terminal, { opened: (request) => requests.push(request), closed() {} });
  let generation = 1;
  const ssh = { connectionGeneration: () => generation } as unknown as SshTransport;
  const auto = vi.fn();
  const bridge = new OperationInputBridge(terminal, ssh, coordinator, auto);
  const operation: ProposedOperation = { id: 'op', kind: 'command', command, scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'deploy', terminalId,
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv'], protectedPaths: [], goal: 'Install service'
  } };
  const abort = new AbortController();
  const result = bridge.execute(operation, operationFingerprint(operation), abort.signal);
  const ready = () => vi.waitFor(() => expect(channel.commands).toEqual([command]), { timeout: 15000 });
  const auth = () => channel.challenge(`challenge-${requests.length}`);
  return { channel, terminal, terminalId, coordinator, requests, auto, result, ready, auth, abort,
    disconnect: () => { generation++; } };
}

afterEach(() => vi.useRealTimers());

describe('ordinary sudo commands with isolated authentication', () => {
  it('requests credentials only when each sudo in a compound command actually asks', async () => {
    const f = fixture("sudo ls /root; echo '--- content ---'; sudo cat /root/test"); await f.ready();
    expect(f.requests).toEqual([]);
    f.auth(); await f.coordinator.answer(f.requests[0]!.id, 'first-password');
    f.channel.emit('--- content ---\r\n');
    f.auth(); await f.coordinator.answer(f.requests[1]!.id, 'second-password');
    f.channel.complete();
    expect((await f.result).status).toBe('succeeded');
    expect(f.channel.writes).toEqual([]);
    expect(f.channel.answers).toHaveLength(2);
  });
  it('executes the exact reviewed command; only a transport challenge can request a password', async () => {
    const f = fixture('sudo od -c /root/test/test'); await f.ready();
    f.channel.emit('Password: '); expect(f.requests).toHaveLength(0);
    f.auth(); expect(f.requests).toHaveLength(1);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'one-password')).toBe(true);
    expect(f.channel.answers).toEqual([{ id: 'challenge-0', answer: 'one-password' }]);
    expect(f.channel.commands).toEqual(['sudo od -c /root/test/test']);
    expect(f.channel.writes).toEqual([]);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'repeat')).toBe(false);
    f.channel.complete(); await f.result;
  });

  it.each(['sudo ls /root | cat', "su root -c 'cat /root/test'", 'sudo -S cat /root/test'])(
    'stops an unsupported form without converting it into a script: %s', async (command) => {
      const f = fixture(command);
      expect(await f.result).toMatchObject({ status: 'failed', requiresUserAction: true });
      expect(f.channel.commands).toEqual([]); expect(f.requests).toEqual([]);
    }
  );

  it('pauses when sudo rejects authentication', async () => {
    const f = fixture('sudo ls /root'); await f.ready(); f.auth();
    await f.coordinator.answer(f.requests[0]!.id, 'wrong');
    f.channel.emit('sudo: 1 incorrect password attempt\r\n'); f.channel.complete(1);
    expect(await f.result).toMatchObject({ status: 'failed', requiresUserAction: true });
    expect(f.terminal.isAgentOwner(f.terminalId)).toBe(false);
  });

  it('keeps a payload failure distinct from sudo authentication failure', async () => {
    const f = fixture('sudo ls /root/missing'); await f.ready();
    f.channel.emit('ls: no such file\r\n'); f.channel.complete(2);
    expect((await f.result).requiresUserAction).not.toBe(true);
    expect(f.terminal.isAgentOwner(f.terminalId)).toBe(true);
  });

  it.each(['exit', 'takeover', 'cancel', 'disconnect'] as const)('invalidates a waiting password on %s', async (event) => {
    const f = fixture(); await f.ready(); f.auth();
    if (event === 'exit') { f.channel.complete(); await f.result; }
    if (event === 'takeover') f.terminal.takeOver(f.terminalId);
    if (event === 'cancel') f.abort.abort();
    if (event === 'disconnect') { f.disconnect(); f.terminal.suspend(f.terminalId); }
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late-secret')).toBe(false);
    expect(f.channel.answers.some((answer) => answer.answer === 'late-secret')).toBe(false);
    expect(f.channel.writes).toEqual([]);
    await f.result;
  });

  it('expires a password popup and rejects newline injection', async () => {
    const f = fixture(); await f.ready(); f.auth();
    expect(await f.coordinator.answer(f.requests[0]!.id, 'secret\necho injected')).toBe(false);
    expect((await f.result).status).toBe('unknown');
    expect(f.channel.writes).toEqual([]);
  });

  it('times out without sending credentials or killing the remote process', async () => {
    const f = fixture(); await f.ready(); vi.useFakeTimers(); f.auth();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await f.coordinator.answer(f.requests[0]!.id, 'late')).toBe(false);
    expect((await f.result).status).toBe('unknown'); expect(f.channel.writes).toEqual([]);
  });

  it('bounds repeated authentication attempts', async () => {
    const f = fixture(); await f.ready();
    for (let i = 0; i < 3; i++) { f.auth(); await f.coordinator.answer(f.requests[i]!.id, 'wrong'); }
    f.auth(); expect(f.requests).toHaveLength(3);
    expect((await f.result).status).toBe('unknown');
  });
});

describe('bounded ordinary apt confirmation', () => {
  it('answers through normal process input after a zero-removal summary', async () => {
    const f = fixture(); await f.ready();
    const output = '0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.\r\nDo you want to continue? [Y/n] ';
    f.channel.emit(output); f.channel.emit(output);
    expect(f.channel.writes).toEqual(['y\n']); expect(f.channel.answers).toEqual([]);
    expect(f.auto).toHaveBeenCalledOnce(); f.channel.complete(); await f.result;
  });

  it.each(['0 to remove\n', '0 upgraded, 3 newly installed, 2 to remove and 0 not upgraded.\n'])(
    'refuses ambiguous or changed impacts', async (summary) => {
      const f = fixture('apt install docker.io'); await f.ready();
      f.channel.emit(`${summary}Do you want to continue? [Y/n] `);
      expect((await f.result).status).toBe('unknown'); expect(f.channel.writes).toEqual(['n\n']);
    }
  );
});
