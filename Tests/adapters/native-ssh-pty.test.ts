import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import { renderNativeExecCommand } from '../../packages/adapters/src/native-exec-command.js';
import { openNativeSshPty, type NativePtyHandle, type NativePtyOutcome } from '../../packages/adapters/src/native-ssh-pty.js';
import { sudoMarkerPrompt } from '../../packages/core/src/sudo-plan.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const PROMPT = sudoMarkerPrompt(NONCE);
const COMMAND = `sudo -k -p '${PROMPT}' 'id'`;
const INPUT = { command: COMMAND, cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh', nonce: NONCE, cols: 120, rows: 30 };

class FakeChannel extends EventEmitter {
  readonly written: string[] = [];
  readonly windows: Array<{ rows: number; cols: number }> = [];
  closed = false;
  destroyed = false;
  write(data: Buffer): boolean { this.written.push(data.toString('utf8')); return true; }
  close(): void { if (this.closed) return; this.closed = true; this.emit('close'); }
  setWindow(rows: number, cols: number): void { this.windows.push({ rows, cols }); }
}

class FakeClient {
  readonly commands: string[] = [];
  readonly options: unknown[] = [];
  channel?: FakeChannel;
  fail = false;
  hang = false;
  exec(command: string, options: unknown, callback: (error: Error | null, stream?: FakeChannel) => void): void {
    this.commands.push(command);
    this.options.push(options);
    if (this.hang) return;
    if (this.fail) { callback(new Error('no pty')); return; }
    this.channel = new FakeChannel();
    callback(null, this.channel);
  }
}

interface Opened {
  client: FakeClient;
  handle: NativePtyHandle;
  data: ReturnType<typeof vi.fn>;
  authentication: ReturnType<typeof vi.fn>;
}

function open(overrides: { fail?: boolean; hang?: boolean; signal?: AbortSignal; current?: () => boolean;
  startupTimeoutMs?: number; cols?: number; rows?: number } = {}): Opened {
  const client = new FakeClient();
  client.fail = overrides.fail === true;
  client.hang = overrides.hang === true;
  const data = vi.fn(), authentication = vi.fn();
  const handle = openNativeSshPty(client as unknown as Pick<Client, 'exec'>,
    { ...INPUT, cols: overrides.cols ?? INPUT.cols, rows: overrides.rows ?? INPUT.rows },
    overrides.current ?? (() => true), { data, authentication }, overrides.signal, overrides.startupTimeoutMs ?? 1000);
  return { client, handle, data, authentication };
}

const feed = (opened: Opened, text: string): void => { opened.client.channel?.emit('data', Buffer.from(text, 'latin1')); };
const written = (opened: Opened): string => opened.client.channel?.written.join('') ?? '';
const recorded = (opened: Opened): string => opened.data.mock.calls.map((call) => call[0] as string).join('');
const challenge = (opened: Opened): string => opened.authentication.mock.calls.at(-1)![0].id as string;

it('dispatches on a dumb echo-off pty and injects the password only into the marker window', async () => {
  const opened = open({ cols: 40, rows: 0 });
  expect(opened.client.commands[0]).toBe(renderNativeExecCommand(
    { command: COMMAND, cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh' }));
  // The marker never wraps: degenerate sizes still request a sane window.
  expect(opened.client.options[0]).toMatchObject({ pty: { term: 'dumb', cols: 80, rows: 1, modes: { ECHO: 0 } } });
  feed(opened, PROMPT);
  expect(opened.authentication).toHaveBeenCalledExactlyOnceWith({ id: expect.stringMatching(/^[a-f0-9]{32}$/u), open: true });
  expect(opened.data).not.toHaveBeenCalled();
  const id = challenge(opened);
  expect(opened.handle.answer(id, 'secret')).toBe(true);
  expect(written(opened)).toBe('secret\n');
  expect(opened.authentication).toHaveBeenCalledTimes(2);
  // sudo's post-read newline stays swallowed while the business output flows.
  feed(opened, '\nuid=0(root) gid=0(root) groups=0(root)\n');
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('uid=0(root) gid=0(root) groups=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toStrictEqual({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
  expect(opened.client.channel!.closed).toBe(true);
});

it('shows a failed sudo attempt and opens exactly one new window per marker', async () => {
  const opened = open();
  feed(opened, PROMPT);
  const first = challenge(opened);
  expect(opened.handle.answer(first, 'wrong')).toBe(true);
  feed(opened, '\nSorry, try again.\n');
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('Sorry, try again.\n');
  feed(opened, PROMPT);
  expect(opened.authentication).toHaveBeenCalledTimes(3);
  const second = challenge(opened);
  expect(second).not.toBe(first);
  expect(opened.handle.answer(second, 'secret')).toBe(true);
  feed(opened, '\nuid=0(root) gid=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
  // Neither credential ever reached recorded output.
  expect(recorded(opened)).not.toContain('wrong');
  expect(recorded(opened)).not.toContain('secret');
});

it('synthesizes the retry notice when sudo swallows the failure without a newline', async () => {
  const opened = open();
  feed(opened, PROMPT);
  expect(opened.handle.answer(challenge(opened), 'wrong')).toBe(true);
  // A sudo variant that prints the failure without the leading newline strands it
  // inside the suppressed region; the user still needs to know why it re-asks.
  feed(opened, 'Sorry, try again.');
  feed(opened, PROMPT);
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('\r\nsudo：密码验证未通过，请重试。\r\n');
  expect(opened.handle.answer(challenge(opened), 'secret')).toBe(true);
  feed(opened, '\nuid=0(root) gid=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
  expect(recorded(opened)).not.toContain('Sorry, try again.');
});

it('emits a forged marker verbatim and never opens a second window for payload echoes', async () => {
  const opened = open();
  feed(opened, PROMPT);
  expect(opened.handle.answer(challenge(opened), 'secret')).toBe(true);
  // A payload that echoes the command line replays the marker without any real
  // failed attempt: the gate must keep the PTY from becoming a password oracle.
  feed(opened, '\ncloudhelm:0123456789abcdef0123456789abcdef password: \nuid=0(root) gid=0(root)\n');
  expect(opened.authentication).toHaveBeenCalledTimes(2);
  expect(recorded(opened)).toContain('cloudhelm:0123456789abcdef0123456789abcdef');
  expect(recorded(opened)).toContain('uid=0(root) gid=0(root)');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toStrictEqual({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
});

it('re-arms suppression around a duplicate marker without minting a second injectable id', async () => {
  const opened = open();
  feed(opened, PROMPT);
  feed(opened, PROMPT);
  expect(opened.authentication).toHaveBeenCalledTimes(1);
  const id = challenge(opened);
  expect(opened.handle.answer(id, 'secret')).toBe(true);
  feed(opened, '\nuid=0(root) gid=0(root)\n');
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('uid=0(root) gid=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
});

it('cancels an open window without writing anything and settles the outcome as unknown', async () => {
  const opened = open();
  feed(opened, PROMPT);
  const id = challenge(opened);
  expect(opened.handle.answer(id, null)).toBe(true);
  expect(written(opened)).toBe('');
  expect(opened.data).not.toHaveBeenCalled();
  expect(opened.authentication).toHaveBeenCalledTimes(2);
  expect(await opened.handle.result).toStrictEqual({ state: 'unknown', reason: 'aborted' });
  expect(opened.client.channel!.closed).toBe(true);
  expect(opened.handle.answer(id, 'late')).toBe(false);
});

it('detects a shell-reported missing sudo but never mistakes sudo\'s own child diagnostic', async () => {
  const missing = open();
  feed(missing, '/bin/sh: sudo: not found\n');
  expect(missing.data).toHaveBeenCalledExactlyOnceWith('/bin/sh: sudo: not found\n');
  missing.client.channel!.emit('exit', 127);
  missing.client.channel!.emit('close');
  expect(await missing.handle.result).toStrictEqual({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: true });

  const child = open();
  feed(child, 'sudo: /usr/bin/tool: command not found\n');
  child.client.channel!.emit('exit', 127);
  child.client.channel!.emit('close');
  expect(await child.handle.result).toStrictEqual({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: false });
});

it('keeps the window answerable while the byte cap lifts suppression on a silent prompt region', async () => {
  const opened = open();
  feed(opened, PROMPT);
  const id = challenge(opened);
  feed(opened, 'A'.repeat(4500));
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('A'.repeat(426));
  expect(opened.handle.answer(id, 'secret')).toBe(true);
  expect(written(opened)).toBe('secret\n');
  feed(opened, '\nuid=0(root) gid=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
});

it('flows an apt confirmation prompt immediately and still finds a marker split across chunks', async () => {
  const immediate = open();
  feed(immediate, 'Do you want to continue? [Y/n] ');
  expect(immediate.data).toHaveBeenCalledExactlyOnceWith('Do you want to continue? [Y/n] ');

  const straddled = open();
  feed(straddled, 'out\rcloudhel');
  expect(straddled.data).toHaveBeenCalledExactlyOnceWith('out\r');
  feed(straddled, `m:${NONCE} password: `);
  expect(straddled.authentication).toHaveBeenCalledExactlyOnceWith({ id: expect.stringMatching(/^[a-f0-9]{32}$/u), open: true });
  expect(straddled.data).toHaveBeenCalledExactlyOnceWith('out\r');
  expect(straddled.handle.answer(challenge(straddled), 'secret')).toBe(true);
  feed(straddled, '\nok\n');
  expect(straddled.data).toHaveBeenNthCalledWith(2, 'ok\n');
  straddled.client.channel!.emit('exit', 0);
  straddled.client.channel!.emit('close');
  expect(await straddled.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
});

it('rejects malformed answers and keeps the window open for the real credential', async () => {
  const opened = open();
  feed(opened, PROMPT);
  const id = challenge(opened);
  expect(opened.handle.answer('f'.repeat(32), 'x')).toBe(false);
  expect(opened.handle.answer(id, 'a\nb')).toBe(false);
  expect(opened.handle.answer(id, 'x'.repeat(4096))).toBe(false);
  expect(opened.authentication).toHaveBeenCalledTimes(1);
  expect(opened.handle.answer(id, 'secret')).toBe(true);
  expect(written(opened)).toBe('secret\n');
  expect(opened.authentication).toHaveBeenCalledTimes(2);
});

it('writes raw pty input and clamps resizes to the marker-safe geometry', async () => {
  const opened = open();
  feed(opened, PROMPT);
  expect(opened.handle.answer(challenge(opened), 'secret')).toBe(true);
  opened.handle.write('\u0003');
  opened.handle.write('y\n');
  expect(written(opened)).toBe('secret\n\u0003y\n');
  opened.handle.resize(50, 10);
  expect(opened.client.channel!.windows).toEqual([{ rows: 10, cols: 80 }]);
});

it('settles allocation failures, timeouts, missing exits, signals and output limits without guessing', async () => {
  const failed = open({ fail: true });
  expect(await failed.handle.result).toStrictEqual({ state: 'unknown', reason: 'allocation' });

  const hanging = open({ hang: true, startupTimeoutMs: 20 });
  expect(await hanging.handle.result).toStrictEqual({ state: 'unknown', reason: 'timeout' });

  const silent = open();
  silent.client.channel!.emit('close');
  expect(await silent.handle.result).toStrictEqual({ state: 'unknown', reason: 'missing-exit' });

  const signaled = open();
  signaled.client.channel!.emit('exit', null, 'SIGTERM', true);
  signaled.client.channel!.emit('close');
  expect(await signaled.handle.result).toStrictEqual({ state: 'signaled', signal: 'SIGTERM', coreDumped: true });

  const flooded = open();
  feed(flooded, 'x');
  flooded.client.channel!.emit('data', Buffer.alloc(1_100_000));
  expect(await flooded.handle.result).toStrictEqual({ state: 'unknown', reason: 'output-limit' });
});

it('returns dead handles without dispatching when authorization already lapsed', async () => {
  const hooks = { data: vi.fn(), authentication: vi.fn() };
  for (const dead of [
    openNativeSshPty(undefined, INPUT, () => true, hooks),
    openNativeSshPty(new FakeClient() as unknown as Pick<Client, 'exec'>, INPUT, () => false, hooks),
    openNativeSshPty(new FakeClient() as unknown as Pick<Client, 'exec'>, INPUT, () => true, hooks, AbortSignal.abort()),
  ]) {
    expect(dead.answer('f'.repeat(32), 'x')).toBe(false);
    dead.write('x');
    dead.resize(80, 24);
    expect(await dead.result).toStrictEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  }
  expect(hooks.authentication).not.toHaveBeenCalled();
});

it('settles an in-flight session as unknown when the caller aborts', async () => {
  const controller = new AbortController();
  const opened = open({ signal: controller.signal });
  feed(opened, PROMPT);
  controller.abort();
  expect(await opened.handle.result).toStrictEqual({ state: 'unknown', reason: 'aborted' });
  expect(opened.authentication).toHaveBeenCalledTimes(2);
});

it('reports authorization expiry when the generation ends before the stream closes', async () => {
  let alive = true;
  const opened = open({ current: () => alive });
  feed(opened, PROMPT);
  alive = false;
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  const outcome: NativePtyOutcome = await opened.handle.result;
  expect(outcome).toStrictEqual({ state: 'unknown', reason: 'authorization-expired' });
});
