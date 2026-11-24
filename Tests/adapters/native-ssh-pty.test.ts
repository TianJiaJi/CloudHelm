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
const SU_MARKER = `cloudhelm:${NONCE}`;

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

function openSu(overrides: { signal?: AbortSignal; current?: () => boolean } = {}): Opened {
  const client = new FakeClient();
  const data = vi.fn(), authentication = vi.fn();
  const handle = openNativeSshPty(client as unknown as Pick<Client, 'exec'>,
    { command: `printf '%s' '${SU_MARKER}'; su -l -s /bin/sh root -c 'id'`, cwd: '/', envPath: '/usr/bin/env',
      shellPath: '/bin/sh', nonce: NONCE, cols: 120, rows: 30, window: 'su-window' as const },
    overrides.current ?? (() => true), { data, authentication }, overrides.signal);
  return { client, handle, data, authentication };
}

it('collects a trailing sudo diagnosis after exit-status without minting any further credential window', async () => {
  const pty = open();
  feed(pty, PROMPT);
  const id = challenge(pty);
  expect(pty.handle.answer(id, 'fixture-only')).toBe(true);
  pty.client.channel!.emit('exit', 1);
  feed(pty, '\r\nadmin is not in the sudoers file.\r\nSorry, try again.\r\n' + PROMPT);
  pty.client.channel!.close();
  expect(await pty.handle.result).toMatchObject({ state: 'exited', exitCode: 1, sudoDenied: true });
  expect(pty.authentication.mock.calls.filter(([event]) => event.open)).toHaveLength(1);
  expect(pty.handle.answer(id, 'fixture-late')).toBe(false);
  expect(written(pty)).toBe('fixture-only\n');
});

it('does not open a su password challenge from buffered output after exit-status', async () => {
  const pty = openSu();
  pty.client.channel!.emit('exit', 1);
  feed(pty, `${SU_MARKER}Password: `);
  pty.client.channel!.close();
  expect(await pty.handle.result).toMatchObject({ state: 'exited', exitCode: 1 });
  expect(pty.authentication).not.toHaveBeenCalled();
  expect(written(pty)).toBe('');
});

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

it('flags a sudoers authorization denial after an accepted credential without classifying retry exhaustion', async () => {
  const denied = open();
  feed(denied, PROMPT);
  expect(denied.handle.answer(challenge(denied), 'secret')).toBe(true);
  feed(denied, '\nadmin is not in the sudoers file.  This incident will be reported.\n');
  expect(denied.data).toHaveBeenCalledExactlyOnceWith('admin is not in the sudoers file.  This incident will be reported.\n');
  denied.client.channel!.emit('exit', 1);
  denied.client.channel!.emit('close');
  expect(await denied.handle.result).toStrictEqual({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, sudoDenied: true });
  expect(recorded(denied)).not.toContain('secret');

  const restricted = open();
  feed(restricted, PROMPT);
  expect(restricted.handle.answer(challenge(restricted), 'secret')).toBe(true);
  feed(restricted, '\nsudo: Sorry, user admin is not allowed to execute \'/bin/id\' as root on host.\n');
  restricted.client.channel!.emit('exit', 1);
  restricted.client.channel!.emit('close');
  expect(await restricted.handle.result).toStrictEqual({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, sudoDenied: true });

  const exhausted = open();
  feed(exhausted, PROMPT);
  expect(exhausted.handle.answer(challenge(exhausted), 'wrong')).toBe(true);
  feed(exhausted, '\nSorry, try again.\n');
  feed(exhausted, PROMPT);
  expect(exhausted.handle.answer(challenge(exhausted), 'wrong')).toBe(true);
  feed(exhausted, '\nSorry, try again.\n');
  feed(exhausted, PROMPT);
  expect(exhausted.handle.answer(challenge(exhausted), 'wrong')).toBe(true);
  feed(exhausted, '\nsudo: 3 incorrect password attempts\n');
  exhausted.client.channel!.emit('exit', 1);
  exhausted.client.channel!.emit('close');
  expect(await exhausted.handle.result).toStrictEqual({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false });
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

it('opens the su window only after the marker and injects exactly one password', async () => {
  const opened = openSu();
  feed(opened, SU_MARKER);
  feed(opened, 'Password: ');
  expect(opened.data).not.toHaveBeenCalled();
  expect(opened.authentication).toHaveBeenCalledExactlyOnceWith({ id: expect.stringMatching(/^[a-f0-9]{32}$/u), open: true });
  const id = challenge(opened);
  expect(opened.handle.answer(id, 'root-secret')).toBe(true);
  expect(written(opened)).toBe('root-secret\n');
  expect(opened.authentication).toHaveBeenCalledTimes(2);
  feed(opened, 'uid=0(root) gid=0(root) groups=0(root)\n');
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('uid=0(root) gid=0(root) groups=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toStrictEqual({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
  expect(recorded(opened)).not.toContain('root-secret');
  expect(recorded(opened)).not.toContain(SU_MARKER);
});

it('classifies pam su rejection, missing su and unknown target accounts from the raw stream', async () => {
  const rejected = openSu();
  feed(rejected, SU_MARKER);
  feed(rejected, 'Password: ');
  expect(rejected.handle.answer(challenge(rejected), 'wrong')).toBe(true);
  feed(rejected, 'su: Authentication failure\n');
  rejected.client.channel!.emit('exit', 1);
  rejected.client.channel!.emit('close');
  expect(await rejected.handle.result).toStrictEqual({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, suAuthenticationFailed: true });
  expect(recorded(rejected)).toContain('su: Authentication failure');
  expect(recorded(rejected)).not.toContain('wrong');

  const missing = openSu();
  feed(missing, SU_MARKER);
  feed(missing, '/bin/sh: su: not found\n');
  expect(missing.data).toHaveBeenCalledExactlyOnceWith('/bin/sh: su: not found\n');
  expect(missing.authentication).not.toHaveBeenCalled();
  missing.client.channel!.emit('exit', 127);
  missing.client.channel!.emit('close');
  expect(await missing.handle.result).toStrictEqual({ state: 'exited', exitCode: 127, markerSeen: true, sudoMissing: false, suMissing: true });

  const busybox = openSu();
  feed(busybox, SU_MARKER);
  feed(busybox, 'su: applet not found\n');
  busybox.client.channel!.emit('exit', 127);
  busybox.client.channel!.emit('close');
  expect(await busybox.handle.result).toStrictEqual({ state: 'exited', exitCode: 127, markerSeen: true, sudoMissing: false, suMissing: true });

  const user = openSu();
  feed(user, SU_MARKER);
  feed(user, 'su: user ghost does not exist\n');
  user.client.channel!.emit('exit', 1);
  user.client.channel!.emit('close');
  expect(await user.handle.result).toStrictEqual({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, suUserMissing: true });
});

it('disarms permanently on a forged marker, a passwordless su or any pre-prompt output', async () => {
  const forged = openSu();
  feed(forged, SU_MARKER);
  feed(forged, `payload ${SU_MARKER} echo`);
  expect(forged.authentication).not.toHaveBeenCalled();
  expect(recorded(forged)).toContain(`payload ${SU_MARKER} echo`);
  // A real su prompt arriving later is ordinary flow-through output, never a window.
  feed(forged, 'Password: ');
  expect(forged.authentication).not.toHaveBeenCalled();
  expect(recorded(forged)).toContain('Password: ');
  forged.client.channel!.emit('exit', 0);
  forged.client.channel!.emit('close');
  expect(await forged.handle.result).toStrictEqual({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });

  const passwordless = openSu();
  feed(passwordless, SU_MARKER);
  feed(passwordless, 'uid=0(root) gid=0(root)\n');
  expect(passwordless.authentication).not.toHaveBeenCalled();
  expect(passwordless.data).toHaveBeenCalledExactlyOnceWith('uid=0(root) gid=0(root)\n');
  passwordless.client.channel!.emit('exit', 0);
  passwordless.client.channel!.emit('close');
  expect(await passwordless.handle.result).toStrictEqual({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
});

it('tolerates line breaks and split prompt chunks between marker and window', async () => {
  const opened = openSu();
  feed(opened, 'banner before\n');
  expect(opened.data).toHaveBeenCalledExactlyOnceWith('banner before\n');
  feed(opened, SU_MARKER);
  feed(opened, '\r\n');
  expect(opened.data).toHaveBeenCalledTimes(2);
  feed(opened, 'Pass');
  feed(opened, 'word: ');
  expect(opened.authentication).toHaveBeenCalledExactlyOnceWith({ id: expect.stringMatching(/^[a-f0-9]{32}$/u), open: true });
  const id = challenge(opened);
  expect(opened.handle.answer(id, 'root-secret')).toBe(true);
  feed(opened, 'uid=0(root)\n');
  expect(recorded(opened)).toContain('uid=0(root)\n');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
});

it('consumes inert prompt-tail whitespace in the open window but cancels on anything else', async () => {
  const tolerant = openSu();
  feed(tolerant, SU_MARKER);
  feed(tolerant, 'Password: ');
  const id = challenge(tolerant);
  feed(tolerant, '  ');
  expect(tolerant.data).not.toHaveBeenCalled();
  expect(tolerant.handle.answer(id, 'root-secret')).toBe(true);
  expect(written(tolerant)).toBe('root-secret\n');

  const cancelled = openSu();
  feed(cancelled, SU_MARKER);
  feed(cancelled, 'Password: ');
  const openId = challenge(cancelled);
  feed(cancelled, 'unexpected');
  expect(cancelled.authentication).toHaveBeenLastCalledWith({ id: openId, open: false });
  expect(recorded(cancelled)).toContain('su：密码窗口期间出现异常输出，密码未写入');
  expect(cancelled.handle.answer(openId, 'root-secret')).toBe(false);
  expect(written(cancelled)).toBe('');
  feed(cancelled, 'later output\n');
  expect(recorded(cancelled)).toContain('later output\n');
  expect(cancelled.authentication).toHaveBeenCalledTimes(2);
});

it('cancels the su window without writing and settles unknown', async () => {
  const opened = openSu();
  feed(opened, SU_MARKER);
  feed(opened, 'Password: ');
  const id = challenge(opened);
  expect(opened.handle.answer(id, null)).toBe(true);
  expect(written(opened)).toBe('');
  expect(opened.data).not.toHaveBeenCalled();
  expect(await opened.handle.result).toStrictEqual({ state: 'unknown', reason: 'aborted' });
  expect(opened.client.channel!.closed).toBe(true);
  expect(opened.handle.answer(id, 'late')).toBe(false);
});

it('keeps su output ordinary after the single injection even on later prompts', async () => {
  const opened = openSu();
  feed(opened, SU_MARKER);
  feed(opened, 'Password: ');
  expect(opened.handle.answer(challenge(opened), 'root-secret')).toBe(true);
  feed(opened, 'Password: ');
  expect(opened.authentication).toHaveBeenCalledTimes(2);
  expect(recorded(opened)).toContain('Password: ');
  opened.client.channel!.emit('exit', 0);
  opened.client.channel!.emit('close');
  expect(await opened.handle.result).toMatchObject({ state: 'exited', exitCode: 0 });
  expect(recorded(opened)).not.toContain('root-secret');
});
