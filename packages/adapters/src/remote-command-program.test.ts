import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteCommandProgram } from './remote-command-program.js';

const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp('/tmp/ch-proc-'); directories.push(directory);
  const program = path.join(directory, 'process.py');
  await writeFile(program, remoteCommandProgram, { mode: 0o700 });
  const events: Array<{ type: string; id?: string; data?: string; code?: number }> = [];
  const child = spawn('python3', [program, '--serve']); children.push(child);
  let pending = ''; let stderr = '';
  child.stdout.on('data', (data: Buffer) => {
    pending += data.toString();
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      events.push(JSON.parse(pending.slice(0, index))); pending = pending.slice(index + 1);
    }
  });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const launch = (argv: string[], sudo = false, command?: string) => send({ argv, cwd: directory, sudo, command, cols: 132, rows: 42 });
  const complete = async () => {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'exit'), JSON.stringify(events) + stderr).toBe(true), { timeout: 5000 });
    return { code: events.find((event) => event.type === 'exit')?.code,
      output: events.filter((event) => event.type === 'data').map((event) => event.data).join('') };
  };
  return { directory, events, send, launch, complete };
}

async function fakeSudo(directory: string): Promise<string> {
  const sudo = path.join(directory, 'sudo');
  await writeFile(sudo, `#!/usr/bin/env python3
import os, subprocess, sys
if sys.argv[1] != '-A': sys.exit(99)
answer = subprocess.run([os.environ['SUDO_ASKPASS']], stdout=subprocess.PIPE, timeout=12)
if answer.returncode != 0 or answer.stdout != b'synthetic-password\\n':
    print('sudo: authentication failed', file=sys.stderr)
    sys.exit(1)
os.execvp(sys.argv[2], sys.argv[2:])
`);
  await chmod(sudo, 0o700);
  return sudo;
}

describe.skipIf(process.platform === 'win32')('real process transport without command wrappers', () => {
  it('shows the full remote prompt and exact command, and initializes the PTY size', async () => {
    const f = await fixture();
    f.launch(['stty', 'size'], false, 'stty size');
    const result = await f.complete();
    expect(result).toMatchObject({ code: 0, output: '42 132\r\n' });
    const display = f.events.filter((event) => event.type === 'display').map((event) => event.data).join('');
    expect(display).toContain('@'); expect(display).toContain(path.basename(f.directory));
    expect(display).toContain('stty size\r\n');
    expect(result.output).not.toContain('stty');
  });
  it('preserves arguments, cwd, stdout, stderr, and exit code without terminal markers', async () => {
    const f = await fixture();
    f.launch(['python3', '-c', 'import os,sys; print(os.getcwd()); print(sys.argv[1]); print("stderr", file=sys.stderr); sys.exit(7)', "literal 'quotes' $HOME"]);
    const result = await f.complete();
    expect(result.code).toBe(7);
    expect(result.output).toContain("literal 'quotes' $HOME");
    expect(result.output).toContain('stderr');
    expect(result.output).toContain(path.basename(f.directory));
    expect(result.output).not.toContain('__CLOUDHELM');
  });

  it('supports ordinary interactive input separately from credentials', async () => {
    const f = await fixture();
    f.launch(['python3', '-c', 'print("Continue?", flush=True); print("answer=" + input())']);
    await vi.waitFor(() => expect(f.events.some((event) => event.data?.includes('Continue?'))).toBe(true));
    f.send({ type: 'input', data: Buffer.from('y\n').toString('base64') });
    expect(await f.complete()).toMatchObject({ code: 0, output: expect.stringContaining('answer=y') });
  });

  it('delivers sudo passwords only to askpass, never to the payload PTY or output', async () => {
    const f = await fixture();
    const sudo = await fakeSudo(f.directory);
    f.launch([sudo, 'python3', '-c', 'print("payload-ready", flush=True); print("stdin=" + input())'], true);
    await vi.waitFor(() => expect(f.events.some((event) => event.type === 'auth'), JSON.stringify(f.events)).toBe(true), { timeout: 10000 });
    const id = f.events.find((event) => event.type === 'auth')!.id;
    f.send({ type: 'answer', id, answer: 'synthetic-password' });
    await vi.waitFor(() => expect(f.events.some((event) => event.data?.includes('payload-ready'))).toBe(true));
    // A late or duplicated credential must not become the business command's stdin.
    f.send({ type: 'answer', id, answer: 'late-password' });
    f.send({ type: 'input', data: Buffer.from('ordinary-input\n').toString('base64') });
    const result = await f.complete();
    expect(result.code).toBe(0);
    expect(result.output).toContain('stdin=ordinary-input');
    expect(JSON.stringify(f.events)).not.toMatch(/synthetic-password|late-password/u);
  }, 15000);

  it('cancels authentication without starting the target executable', async () => {
    const f = await fixture();
    f.launch([await fakeSudo(f.directory), 'echo', 'must-not-run'], true);
    await vi.waitFor(() => expect(f.events.some((event) => event.type === 'auth')).toBe(true), { timeout: 10000 });
    f.send({ type: 'answer', id: f.events.find((event) => event.type === 'auth')!.id, answer: null });
    const result = await f.complete();
    expect(result.code).toBe(1); expect(result.output).not.toContain('must-not-run');
  }, 15000);
});
