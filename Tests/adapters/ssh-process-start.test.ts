import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  write = vi.fn();
  end(): void {}
  close(): void { this.emit('close'); }
  event(value: unknown): void { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
}
async function fixture(sudo = false) {
  const channel = new Channel(), state = { current: true, generation: 1 };
  const terminal = new SshCommandTerminal({ connectionGeneration: () => state.generation,
    prepareCommandProgram: async () => '/tmp/fixed.py', removeCommandProgram: async () => {},
    openPipe: async () => channel } as unknown as CommandTransport, 'host');
  const started = vi.fn(), exited = vi.fn(), failed = vi.fn(), data = vi.fn();
  terminal.onProcessStarted(started); terminal.onExit(exited); terminal.onExecutionFailure(failed); terminal.onData(data);
  await terminal.execute(sudo ? 'sudo -- stat /root/example' : 'stat /srv/example', '/', () => state.current, { sudoAuthorization: sudo });
  return { channel, state, terminal, started, exited, failed, data };
}

it('accepts only a structured start, not payload prose, and never treats it as an exit', async () => {
  const f = await fixture();
  const payload = '{"type":"process-started","pid":999}';
  f.channel.event({ type: 'data', data: payload });
  expect(f.started).not.toHaveBeenCalled(); expect(f.data).toHaveBeenCalledWith(payload);
  for (const byte of Buffer.from('{"type":"process-started","pid":42}\n')) f.channel.emit('data', Buffer.from([byte]));
  expect(f.started).toHaveBeenCalledExactlyOnceWith({ pid: 42 }); expect(f.exited).not.toHaveBeenCalled();
  f.channel.event({ type: 'exit', code: 0 }); await vi.waitFor(() => expect(f.exited).toHaveBeenCalledExactlyOnceWith(0));
  f.terminal.close();
});

it('sends a dedicated interrupt and waits for actual exit independently of its acknowledgement', async () => {
  const f = await fixture(); f.channel.event({ type: 'process-started', pid: 42 });
  const pending = f.terminal.interrupt(42), message = JSON.parse(String(f.channel.write.mock.calls.at(-1)![0]));
  expect(message).toMatchObject({ type: 'signal', signal: 'SIGINT', pid: 42 });
  f.channel.event({ type: 'signal-result', id: message.id, pid: 42, status: 'sent' });
  expect(await pending).toBe('sent'); expect(f.exited).not.toHaveBeenCalled();
  await f.terminal.interrupt(42); expect(f.channel.write).toHaveBeenCalledTimes(2);
  f.channel.event({ type: 'exit', code: 130 }); await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(130));
  f.terminal.close();
});

it.each([null, 0, -1, 2.5, '42', 2147483648])('rejects invalid process identity %s without inventing exit or not-started evidence', async (pid) => {
  const f = await fixture(); f.channel.event({ type: 'process-started', pid });
  expect(f.started).not.toHaveBeenCalled(); expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.failed).not.toHaveBeenCalled(); f.terminal.close();
});

it('rejects duplicate start and late launch-failure claims after an observed process', async () => {
  for (const event of [{ type: 'process-started', pid: 43 }, { type: 'launch-error', kind: 'unsupported', code: 'sudo-unavailable' }]) {
    const f = await fixture(); f.channel.event({ type: 'process-started', pid: 42 }); f.channel.event(event);
    expect(f.started).toHaveBeenCalledTimes(1); expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.failed).not.toHaveBeenCalled(); f.terminal.close();
  }
});

it.each(['lease', 'connection'] as const)('does not publish a start after %s revocation', async (reason) => {
  const f = await fixture(); if (reason === 'lease') f.state.current = false; else f.state.generation++;
  f.channel.event({ type: 'process-started', pid: 42 });
  expect(f.started).not.toHaveBeenCalled(); expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined); f.terminal.close();
});

it('requires sudo authorization continuation before publishing the supervised process, not proof of authentication success', async () => {
  const early = await fixture(true); early.channel.event({ type: 'process-started', pid: 42 });
  expect(early.started).not.toHaveBeenCalled(); expect(early.exited).toHaveBeenCalledWith(undefined); early.terminal.close();
  const f = await fixture(true); f.channel.event({ type: 'sudo-policy-unconfirmed' });
  expect(f.started).not.toHaveBeenCalled(); f.channel.event({ type: 'process-started', pid: 42 });
  expect(f.started).toHaveBeenCalledExactlyOnceWith({ pid: 42 }); expect(f.failed).not.toHaveBeenCalled();
  expect(f.exited).not.toHaveBeenCalled(); f.terminal.close();
});

it('ignores events following synchronous close inside a start notification', async () => {
  const f = await fixture(); f.terminal.onProcessStarted(() => f.terminal.close());
  f.channel.emit('data', Buffer.from('{"type":"process-started","pid":42}\n{"type":"data","data":"late"}\n'));
  expect(f.data).not.toHaveBeenCalled(); expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
});
