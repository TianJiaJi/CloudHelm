import { expect, it, vi } from 'vitest';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';
import type { NativeExecOutcome } from '../../packages/adapters/src/native-ssh-exec.js';
import {
  NATIVE_BACKGROUND_PROC_GONE, parseNativeBackgroundExit, parseNativeBackgroundPid, parseNativeBackgroundStat,
  renderNativeBackgroundLaunch, renderNativeBackgroundLogPath, renderNativeBackgroundStatCheck, renderNativeBackgroundStop,
  renderNativeBackgroundWatcher
} from '../../packages/adapters/src/native-background.js';
import type { ProcessStartedEvent } from '../../packages/core/src/ports.js';
import { validBackgroundLogPath } from '../../packages/core/src/execution-job.js';

const pid = 4242;
const processStartTime = 123456;
const statLine = (fields: Partial<{ pgrp: number; session: number; starttime: number }> = {}): string => {
  const tokens = Array.from({ length: 44 }, (_value, index) => (index === 0 ? 'S' : String(index)));
  tokens[2] = String(fields.pgrp ?? pid);
  tokens[3] = String(fields.session ?? pid);
  tokens[19] = String(fields.starttime ?? processStartTime);
  return `${pid} (sleep) ${tokens.join(' ')}`;
};

it('renders a detached launch that embeds the reviewed command once and reports the group pid', () => {
  const logPath = renderNativeBackgroundLogPath();
  expect(validBackgroundLogPath(logPath)).toBe(true);
  expect(renderNativeBackgroundLaunch({ command: 'sleep 300', logPath })).toBe(
    `umask 077\nsetsid /bin/sh -c 'sleep 300\nprintf '\\''__CLOUDHELM_EXIT__%s\\n'\\'' "$?"' > '${logPath}' 2>&1 < /dev/null &\necho $!`);
  expect(() => renderNativeBackgroundLaunch({ command: 'sleep 300', logPath: '/tmp/agent-chosen.log' })).toThrow();
  expect(() => renderNativeBackgroundLaunch({ command: '', logPath })).toThrow();
  expect(() => renderNativeBackgroundLaunch({ command: 'sleep 300\u0000', logPath })).toThrow();
  expect(() => renderNativeBackgroundLaunch({ command: 'sleep '.repeat(2000), logPath })).toThrow('exceeds the dispatch limit');
});

it('accepts only a trailing integer pid from the launch output', () => {
  expect(parseNativeBackgroundPid(`${pid}\n`)).toBe(pid);
  expect(parseNativeBackgroundPid('noise\n4242\n')).toBe(pid);
  expect(parseNativeBackgroundPid('4242\n43\n')).toBe(43);
  expect(parseNativeBackgroundPid('')).toBeUndefined();
  expect(parseNativeBackgroundPid('not-a-pid\n')).toBeUndefined();
  expect(parseNativeBackgroundPid('-1\n')).toBeUndefined();
  expect(parseNativeBackgroundPid(`${2 ** 31}\n`)).toBeUndefined();
});

it('parses the stat invariant: own process group and session bound by the kernel starttime', () => {
  expect(parseNativeBackgroundStat(statLine(), pid)).toEqual({ processStartTime });
  expect(parseNativeBackgroundStat(statLine(), pid + 1)).toBeUndefined();
  expect(parseNativeBackgroundStat(statLine({ pgrp: 1 }), pid)).toBeUndefined();
  expect(parseNativeBackgroundStat(statLine({ session: 1 }), pid)).toBeUndefined();
  expect(parseNativeBackgroundStat(statLine({ starttime: 999 }), pid)).toEqual({ processStartTime: 999 });
  expect(parseNativeBackgroundStat(NATIVE_BACKGROUND_PROC_GONE, pid)).toBeUndefined();
  expect(parseNativeBackgroundStat('', pid)).toBeUndefined();
});

it('renders bounded observation and exact-group stop commands', () => {
  const logPath = renderNativeBackgroundLogPath();
  expect(renderNativeBackgroundStatCheck(pid)).toBe(
    `if [ -e '/proc/${pid}/stat' ]; then cat '/proc/${pid}/stat'; else printf '%s' '${NATIVE_BACKGROUND_PROC_GONE}'; fi`);
  expect(renderNativeBackgroundWatcher(pid, logPath)).toBe(
    `while [ -d '/proc/${pid}' ]; do sleep 2; done\ntail -c 256 '${logPath}'`);
  expect(() => renderNativeBackgroundWatcher(pid, '/tmp/other.log')).toThrow();
  expect(renderNativeBackgroundStop(pid)).toBe(`/bin/kill -INT -- -${pid}`);
});

it('reads the exit code only from the backend marker in the bounded tail', () => {
  expect(parseNativeBackgroundExit('done\n__CLOUDHELM_EXIT__0\n')).toBe(0);
  expect(parseNativeBackgroundExit('__CLOUDHELM_EXIT__130\n')).toBe(130);
  expect(parseNativeBackgroundExit('process finished successfully\n')).toBeUndefined();
  expect(parseNativeBackgroundExit('__CLOUDHELM_EXIT__256\n')).toBeUndefined();
  expect(parseNativeBackgroundExit('')).toBeUndefined();
});

interface BackgroundCall { command: string; cwd: string }

/** Scripted native transport: every rendered command is answered in order. */
function backgroundFixture(script: (call: BackgroundCall, hooks: { stdout(data: Buffer): void }) => NativeExecOutcome | Promise<NativeExecOutcome>) {
  const calls: BackgroundCall[] = [];
  const execFixed = vi.fn(async () => ({ exitCode: 0, output: '' }));
  const runNativeExec = vi.fn(async (_hostId: string, input: { command: string; cwd: string },
    _authorized: () => boolean, hooks: { stdout(data: Buffer): void; stderr(data: Buffer): void },
    _signal?: AbortSignal): Promise<NativeExecOutcome> => {
    const call: BackgroundCall = { command: input.command, cwd: input.cwd };
    calls.push(call);
    return await script(call, hooks);
  });
  const ssh = { connectionGeneration: () => 1, execFixed, runNativeExec } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(ssh, 'host');
  const started = vi.fn((_event: ProcessStartedEvent) => {});
  const exited = vi.fn(); const data = vi.fn(); const failure = vi.fn();
  terminal.onProcessStarted(started); terminal.onExit(exited); terminal.onData(data); terminal.onExecutionFailure(failure);
  return { terminal, execFixed, runNativeExec, calls, started, exited, data, failure };
}

const isLaunch = (call: BackgroundCall) => call.command.startsWith('umask 077\n');
const isStatCheck = (call: BackgroundCall) => call.command.startsWith(`if [ -e '/proc/${pid}/stat'`);
const isWatcher = (call: BackgroundCall) => call.command.startsWith(`while [ -d '/proc/${pid}'`);
const isStop = (call: BackgroundCall) => call.command === `/bin/kill -INT -- -${pid}`;
const hold = () => new Promise<NativeExecOutcome>(() => {});

it('launches detached, verifies the group invariant, reports start facts and settles from the log marker', async () => {
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from(`${pid}\n`));
    else if (isStatCheck(call)) hooks.stdout(Buffer.from(statLine()));
    else if (isWatcher(call)) hooks.stdout(Buffer.from('done\n__CLOUDHELM_EXIT__7\n'));
    return { state: 'exited', exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(f.calls[0]).toMatchObject({ cwd: '/srv' });
  expect(f.calls[0]!.command).toContain("setsid /bin/sh -c 'sleep 300\n");
  expect(f.calls[1]).toMatchObject({ command: expect.stringContaining(`/proc/${pid}/stat`), cwd: '/' });
  expect(f.started).toHaveBeenCalledExactlyOnceWith({ pid, logPath: expect.any(String), processStartTime });
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  const logPath = f.started.mock.calls[0]![0].logPath!;
  expect(validBackgroundLogPath(logPath)).toBe(true);
  expect(f.calls[2]!.command).toContain(`tail -c 256 '${logPath}'`);
  await vi.waitFor(() => expect(f.exited).toHaveBeenCalledExactlyOnceWith(7));
});

it('re-verifies the exact process group before a reviewed stop and reports confirmed delivery', async () => {
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from(`${pid}\n`));
    else if (isStatCheck(call)) hooks.stdout(Buffer.from(statLine()));
    else if (isWatcher(call)) return hold();
    return { state: 'exited', exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  await expect(f.terminal.interrupt(pid)).resolves.toBe('sent');
  expect(f.calls.filter(isStop)).toHaveLength(1);
  expect(f.calls.find(isStop)!.cwd).toBe('/');
});

it('refuses to signal a reused pid whose starttime no longer matches the launch observation', async () => {
  let reused = false;
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from(`${pid}\n`));
    else if (isStatCheck(call)) hooks.stdout(Buffer.from(statLine(reused ? { starttime: 999 } : {})));
    else if (isWatcher(call)) return hold();
    return { state: 'exited', exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  reused = true;
  await expect(f.terminal.interrupt(pid)).rejects.toThrow('PID reuse');
  expect(f.calls.some(isStop)).toBe(false);
});

it('treats a vanished process as already exited instead of sending a second signal', async () => {
  let gone = false;
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from(`${pid}\n`));
    else if (isStatCheck(call)) hooks.stdout(Buffer.from(gone ? NATIVE_BACKGROUND_PROC_GONE : statLine()));
    else if (isWatcher(call)) return hold();
    return { state: 'exited', exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  gone = true;
  await expect(f.terminal.interrupt(pid)).resolves.toBe('already-exited');
  expect(f.calls.some(isStop)).toBe(false);
});

it('settles a business that exited before verification from the private log marker without a start report', async () => {
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from(`${pid}\n`));
    else if (isStatCheck(call)) hooks.stdout(Buffer.from(NATIVE_BACKGROUND_PROC_GONE));
    else if (isWatcher(call)) hooks.stdout(Buffer.from('done\n__CLOUDHELM_EXIT__3\n'));
    return { state: 'exited', exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(f.started).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(3);
});

it('fails closed when the launch cannot be dispatched or its result is unknown', async () => {
  const notDispatched = backgroundFixture(() => ({ state: 'not-dispatched' as const, reason: 'authorization-expired' as const }));
  await notDispatched.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(notDispatched.failure).toHaveBeenCalledWith({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
  expect(notDispatched.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(notDispatched.started).not.toHaveBeenCalled();

  const unknown = backgroundFixture((call) => isLaunch(call) ? { state: 'unknown' as const, reason: 'timeout' as const } : { state: 'exited' as const, exitCode: 0 });
  await unknown.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(unknown.failure).not.toHaveBeenCalled();
  expect(unknown.data).toHaveBeenCalledWith(expect.stringContaining('未知'));
  expect(unknown.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(unknown.started).not.toHaveBeenCalled();
});

it('reports a launch that failed inside the wrapping shell without claiming a start', async () => {
  const f = backgroundFixture((call) => isLaunch(call) ? { state: 'exited' as const, exitCode: 127 } : { state: 'exited' as const, exitCode: 0 });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(f.data).toHaveBeenCalledWith(expect.stringContaining('未启动'));
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(127);
  expect(f.started).not.toHaveBeenCalled();
});

it('keeps the result unknown when the launch output carries no process identity', async () => {
  const f = backgroundFixture((call, hooks) => {
    if (isLaunch(call)) hooks.stdout(Buffer.from('garbage\n'));
    return { state: 'exited' as const, exitCode: 0 };
  });
  await f.terminal.execute('sleep 300', '/srv', () => true, { executionChannel: 'native-background' });
  expect(f.started).not.toHaveBeenCalled();
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.data).toHaveBeenCalledWith(expect.stringContaining('无法解析'));
});

it('refuses a channel that no longer matches the reviewed background form', async () => {
  const f = backgroundFixture(() => ({ state: 'exited' as const, exitCode: 0 }));
  await expect(f.terminal.execute('nohup sleep 300', '/srv', () => true, { executionChannel: 'native-background' }))
    .rejects.toThrow('no longer matches');
  expect(f.runNativeExec).not.toHaveBeenCalled();
  expect(f.execFixed).not.toHaveBeenCalled();
});
