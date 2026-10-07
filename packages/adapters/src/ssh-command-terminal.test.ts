import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SshTransport } from './ssh-transport.js';
import { SshCommandTerminal } from './ssh-command-terminal.js';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  write(text: string): void { this.writes.push(text); }
  end(): void {}
  close(): void { this.emit('close'); }
  setWindow = vi.fn();
  event(value: unknown): void { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
}
function fixture() {
  const channel = new Channel();
  const prepareCommandProgram = vi.fn(async () => '/tmp/cloudhelm-run.fixture/process.py');
  const channels = [channel];
  const openPipe = vi.fn(async () => {
    if (channels.length === 1 && !channel.writes.length) return channel;
    const next = new Channel(); channels.push(next); return next;
  });
  const human = new Channel();
  const shell = vi.fn(async () => human);
  const ssh = { connectionGeneration: () => 1, prepareCommandProgram, openPipe, shell } as unknown as SshTransport;
  const terminal = new SshCommandTerminal(ssh, 'host');
  const output = vi.fn(); const exited = vi.fn(); const auth = vi.fn(); const display = vi.fn();
  terminal.onDisplay(display); terminal.onData(output); terminal.onExit(exited); terminal.onAuthentication(auth);
  return { channel, channels, human, shell, display, terminal, output, exited, auth, prepareCommandProgram, openPipe };
}

describe('direct SSH command transport', () => {
  it.each([
    ["sudo ls -la /root/test; echo '--- content ---'; sudo cat /root/test/test", [0, 0, 0], ['sudo', 'echo', 'sudo']],
    ['sudo false && sudo echo skip || sudo echo recover', [1, 0], ['sudo', 'sudo']],
    ['sudo true || sudo echo skip; sudo echo next', [0, 0], ['sudo', 'sudo']],
    ['sudo true\nsudo echo next', [0, 0], ['sudo', 'sudo']]
  ] as const)('executes foreground list %s with shell conditions', async (command, codes, names) => {
    const f = fixture(); await f.terminal.execute(command, '/', () => true);
    for (const [index, code] of codes.entries()) {
      await vi.waitFor(() => expect(f.channels[index]?.writes.length).toBe(1), { timeout: 15000 });
      const launch = JSON.parse(f.channels[index]!.writes[0]!);
      expect(launch.argv[0]).toBe(names[index]);
      expect(launch.sudo).toBe(names[index] === 'sudo');
      expect(launch.command).toBe(index === 0 ? command : undefined);
      expect(launch.argv).not.toContain('skip');
      f.channels[index]!.event({ type: 'exit', code });
    }
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['sudo cat /root/test &', 'sudo cat /root/test | cat', 'sudo -S cat /root/test',
    'sudo sh -c "cat /root/test"', 'if true; then sudo id; fi', 'sudo echo "$HOME"',
    '(sudo id)', 'sudo id > /tmp/output'])('does not misparse %s into a foreground list', async (command) => {
    const f = fixture();
    await expect(f.terminal.execute(command, '/', () => true)).rejects.toThrow('manual takeover');
    expect(f.openPipe).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'disconnect'] as const)('never sends the next command after %s', async (reason) => {
    const f = fixture(); let authorized = true;
    await f.terminal.execute('sudo id; sudo mkdir /root/test', '/', () => authorized);
    if (reason === 'revoked') { authorized = false; f.channel.event({ type: 'exit', code: 0 }); }
    else f.channel.emit('close');
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledWith(undefined), { timeout: 15000 });
    expect(f.openPipe).toHaveBeenCalledOnce();
  });

  it('keeps full prompts and command echo out of captured output', async () => {
    const f = fixture(); f.terminal.resize(132, 42);
    await f.terminal.execute('sudo id', '/home/ubuntu', () => true);
    expect(JSON.parse(f.channel.writes[0]!)).toMatchObject({ cols: 132, rows: 42 });
    const prompt = '\u001b[01;32mubuntu@instance\u001b[00m:~$ ';
    f.channel.event({ type: 'prompt', data: prompt });
    f.channel.event({ type: 'display', data: `${prompt}sudo id\r\n` });
    f.channel.event({ type: 'data', data: 'uid=0(root)\r\n' });
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.display.mock.calls.flat().join('')).toBe(`${prompt}sudo id\r\n${prompt}`);
    expect(f.output).toHaveBeenCalledExactlyOnceWith('uid=0(root)\r\n');
  });

  it('opens a sized interactive shell immediately on idle takeover, without extra Enter presses', async () => {
    const f = fixture(); f.terminal.resize(132, 42); f.terminal.takeOver();
    f.terminal.write('su -\r');
    await vi.waitFor(() => expect(f.human.writes).toEqual(['su -\r']), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledExactlyOnceWith('host', 132, 42);
    expect(f.human.setWindow).toHaveBeenCalledWith(42, 132, 0, 0);
  });

  it('states the handover and erases the synthetic prompt before a later takeover shell', async () => {
    const f = fixture(); await f.terminal.execute('du -xhd1 /usr', '/home/tian', () => true);
    f.channel.event({ type: 'prompt', data: 'tian@ubuntu:~$ ' });
    f.channel.event({ type: 'data', data: '3.4G\t/usr\n' });
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.output).toHaveBeenCalledExactlyOnceWith('3.4G\t/usr\n');
    expect(f.display.mock.calls.flat().join('')).toBe('tian@ubuntu:~$ ');
    f.terminal.takeOver();
    await vi.waitFor(() => expect(f.display.mock.calls.flat().join(''))
      .toBe('tian@ubuntu:~$ \r\x1b[2K—— 终端已交还人工输入 ——\r\n'), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledExactlyOnceWith('host', 100, 30);
  });

  it('skips the synthetic prompt when the exit report hands the terminal over at once', async () => {
    const f = fixture();
    f.exited.mockImplementation(() => f.terminal.takeOver());
    await f.terminal.execute('du -xhd1 /usr', '/home/tian', () => true);
    f.channel.event({ type: 'prompt', data: 'tian@ubuntu:~$ ' });
    f.channel.event({ type: 'data', data: '3.4G\t/usr\n' });
    f.channel.event({ type: 'exit', code: 0 });
    await vi.waitFor(() => expect(f.display.mock.calls.flat().join(''))
      .toBe('—— 终端已交还人工输入 ——\r\n'), { timeout: 15000 });
    expect(f.shell).toHaveBeenCalledOnce();
  });

  it.each(['od -c /root/test/test', 'sudo od -c /root/test/test'])('passes %s as literal executable arguments', async (command) => {
    const f = fixture(); await f.terminal.execute(command, '/home/ubuntu', () => true);
    expect(JSON.parse(f.channel.writes[0]!)).toEqual({ argv: command.split(' '), cwd: '/home/ubuntu', sudo: command.startsWith('sudo '), command, cols: 100, rows: 30 });
    expect(f.openPipe).toHaveBeenCalledWith('host', 'python3 -I -u /tmp/cloudhelm-run.fixture/process.py --serve');
    expect(f.channel.writes.join('')).not.toMatch(/env -i|SUDO_ASKPASS|\/bin\/sh|CLOUDHELM_DONE/u);
    f.channel.event({ type: 'data', data: 'literal __CLOUDHELM_DONE_example__:0\n' });
    expect(f.exited).not.toHaveBeenCalled();
    f.channel.event({ type: 'exit', code: 7 });
    expect(f.exited).toHaveBeenCalledWith(7);
  });

  it('keeps a canceled or duplicate password out of ordinary input', async () => {
    const f = fixture(); await f.terminal.execute('sudo cat /root/test', '/', () => true);
    const id = 'a'.repeat(32);
    f.channel.event({ type: 'auth', id });
    expect(f.auth).toHaveBeenCalledWith({ id, prompt: 'sudo 身份验证' });
    expect(f.terminal.answerAuthentication(id, 'synthetic-password')).toBe(true);
    expect(f.terminal.answerAuthentication(id, 'late')).toBe(false);
    expect(JSON.parse(f.channel.writes[1]!)).toEqual({ type: 'answer', id, answer: 'synthetic-password' });
    expect(f.output).not.toHaveBeenCalled();
    f.channel.event({ type: 'exit', code: 0 });
    expect(f.terminal.answerAuthentication(id, 'later')).toBe(false);
  });

  it('rejects a revoked lease before sending any process launch', async () => {
    const f = fixture(); let current = true;
    f.prepareCommandProgram.mockImplementationOnce(async () => { current = false; return '/tmp/cloudhelm-run.fixture/process.py'; });
    await expect(f.terminal.execute('pwd', '/', () => current)).rejects.toThrow('authorization expired');
    expect(f.openPipe).not.toHaveBeenCalled(); expect(f.channel.writes).toEqual([]);
  });

  it('does not interpret plain process output as an authentication request', async () => {
    const f = fixture(); await f.terminal.execute('cat /tmp/file', '/', () => true);
    f.channel.event({ type: 'data', data: '{"type":"auth","id":"fake"}\nPassword: ' });
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.output).toHaveBeenCalledOnce();
  });

  it('reports unknown outcome on transport loss, without replaying the command', async () => {
    const f = fixture(); await f.terminal.execute('mkdir -p /tmp/example', '/', () => true);
    f.channel.emit('close');
    expect(f.exited).toHaveBeenCalledWith(undefined);
    expect(f.openPipe).toHaveBeenCalledOnce();
  });
});
