import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SshTransport } from '../../packages/adapters/src/ssh-transport.js';
import { SshCommandTerminal } from '../../packages/adapters/src/ssh-command-terminal.js';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  write(text: string): void { this.writes.push(text); }
  end(): void {}
  close(): void { this.emit('close'); }
  setWindow = vi.fn();
}

function fixture() {
  const human = new Channel();
  const shell = vi.fn(async () => human);
  const ssh = { connectionGeneration: () => 1, shell } as unknown as SshTransport;
  const terminal = new SshCommandTerminal(ssh, 'host');
  const display = vi.fn(); const output = vi.fn();
  terminal.onDisplay(display); terminal.onData(output);
  return { human, shell, display, output, terminal };
}

describe('direct SSH command transport', () => {
  it('opens a sized interactive shell immediately on idle takeover, without extra Enter presses', async () => {
    const f = fixture(); f.terminal.resize(132, 42); f.terminal.takeOver();
    f.terminal.write('su -\r');
    await vi.waitFor(() => expect(f.human.writes).toEqual(['su -\r']), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledExactlyOnceWith('host', 132, 42);
    expect(f.human.setWindow).toHaveBeenCalledWith(42, 132, 0, 0);
  });

  it('states the handover before the takeover shell and reuses the open channel', async () => {
    const f = fixture();
    f.terminal.takeOver();
    await vi.waitFor(() => expect(f.display).toHaveBeenCalledExactlyOnceWith('—— 终端已交还人工输入 ——\r\n'), { timeout: 15000 });
    f.terminal.write('id\n');
    expect(f.human.writes).toEqual(['id\n']);
    f.terminal.resize(120, 40);
    expect(f.human.setWindow).toHaveBeenCalledWith(40, 120, 0, 0);
  });

  it('rejects a channel-less command form without dispatching anything', async () => {
    const f = fixture();
    await expect(f.terminal.execute('if true; then id; fi', '/', () => true)).rejects.toThrow('no native execution channel');
    expect(f.shell).not.toHaveBeenCalled();
  });

  it('reports sudo and su channel forms as manual-takeover territory rather than dispatching', async () => {
    const f = fixture();
    await expect(f.terminal.execute('sudo -S cat /root/test', '/', () => true)).rejects.toThrow('no native execution channel');
    await expect(f.terminal.execute('su -', '/', () => true)).rejects.toThrow('no native execution channel');
    expect(f.shell).not.toHaveBeenCalled();
  });
});
