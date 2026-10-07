import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuSession } from './su-session.js';
import { suRootProgram } from './su-session-program.js';
import { SshCommandTerminal } from './ssh-command-terminal.js';
import type { SshTransport } from './ssh-transport.js';

// Exercise actual authentication PTY, broker, socket and command processes. Only the su
// binary and root UID/peer checks are replaced: these tests never elevate the local user.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = await mkdtemp('/tmp/cloudhelm-su-');
  const children: ChildProcessWithoutNullStreams[] = [];
  cleanup.push(async () => { for (const child of children) child.kill(); await rm(directory, { recursive: true, force: true }); });
  const executable = join(directory, 'su'); const program = join(directory, 'process.py');
  await writeFile(executable, `#!/usr/bin/env python3
import os,sys,termios
old=termios.tcgetattr(0); changed=termios.tcgetattr(0); changed[3] &= ~termios.ECHO; termios.tcsetattr(0,termios.TCSANOW,changed)
sys.stdout.write('Password:'); sys.stdout.flush()
answer=sys.stdin.readline().strip()
termios.tcsetattr(0,termios.TCSANOW,old)
if answer != 'synthetic-root-password': sys.exit(1)
os.execv('/bin/sh',['/bin/sh','-c',sys.argv[-1]])
`, { mode: 0o700 });
  const testRoot = suRootProgram.replace('if os.getuid() != 0:', 'if False:').replace("'uid': os.getuid()", "'uid': 0");
  let stderr = '';
  const ssh = {
    connectionGeneration: () => 1,
    prepareCommandProgram: async (_id: string, source: string, current: () => void) => {
      current();
      const testSource = source.replace(Buffer.from(suRootProgram).toString('base64'), Buffer.from(testRoot).toString('base64'))
        .replace("'/usr/bin/su'", JSON.stringify(executable))
        .replace("_, uid, _ = struct.unpack('3i', candidate.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))", 'uid = 0');
      await writeFile(program, testSource, { mode: 0o700 }); return program;
    },
    removeCommandProgram: async () => {},
    openPipe: async () => {
      const child = spawn('python3', [program]); children.push(child);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      const channel = new EventEmitter() as any;
      channel.stderr = child.stderr;
      child.stdout.on('data', (chunk) => channel.emit('data', chunk));
      child.on('close', () => channel.emit('close')); child.on('error', (error) => channel.emit('error', error));
      channel.write = (data: string, callback?: () => void) => child.stdin.write(data, callback);
      channel.end = () => child.stdin.end(); channel.close = () => child.kill();
      return channel;
    }
  } as unknown as SshTransport;
  const controller = new AbortController();
  const session = new SuSession(ssh, 'host', controller.signal, () => {});
  cleanup.push(async () => session.close());
  const output: string[] = []; const display: string[] = []; const exits: Array<number | undefined> = [];
  const terminal = new SshCommandTerminal(session, 'host');
  terminal.onData((text) => output.push(text)); terminal.onDisplay((text) => display.push(text)); terminal.onExit((code) => exits.push(code));
  return { session, terminal, controller, output, display, exits, stderr: () => stderr, directory };
}

describe.skipIf(process.platform === 'win32')('su private authentication and independent command input', () => {
  it('keeps password out of output and payload stdin, and reuses the confirmed session', async () => {
    const f = await fixture(); const ask = vi.fn(async () => 'synthetic-root-password');
    await f.session.connect(ask, () => {}); expect(ask).toHaveBeenCalledOnce();
    await f.terminal.execute(`python3 -c 'print("payload-ready", flush=True); print("stdin=" + input())'`, f.directory, () => true);
    await vi.waitFor(() => expect(f.output.join(''), f.stderr()).toContain('payload-ready'), { timeout: 10000 });
    f.terminal.write('ordinary-input\n');
    await vi.waitFor(() => expect(f.exits, f.stderr()).toEqual([0]), { timeout: 10000 });
    expect(f.output.join('')).toContain('stdin=ordinary-input');
    await f.terminal.execute('printf second-operation', f.directory, () => true);
    await vi.waitFor(() => expect(f.exits, f.stderr()).toEqual([0, 0]), { timeout: 10000 });
    expect(f.output.join('')).toContain('second-operation');
    expect([...f.output, ...f.display, f.stderr()].join('')).not.toContain('synthetic-root-password');
    expect(f.display.join('')).toContain('@');
    f.controller.abort(); await expect(f.session.openPipe()).rejects.toThrow('expired');
  });
  it.each([null, 'incorrect-password'])('closes without executing a payload on rejected auth: %s', async (answer) => {
    const f = await fixture(); await expect(f.session.connect(async () => answer, () => {})).rejects.toThrow('authentication');
    expect(f.output).toEqual([]); await expect(f.session.openPipe()).rejects.toThrow('expired');
  });
  it('discards a late credential after cancellation', async () => {
    const f = await fixture(); let respond!: (answer: string) => void;
    const pending = f.session.connect(() => new Promise((resolve) => { respond = resolve; }), () => {});
    const rejected = expect(pending).rejects.toThrow('authentication');
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'), { timeout: 10000 });
    f.controller.abort(); respond('synthetic-root-password'); await rejected;
    expect(f.output).toEqual([]);
  });
});
