import { expect, it, vi } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { suPtyCommand } from '../../packages/core/src/su-plan.js';
import { OBSERVATION_LIMITS } from '../../packages/core/src/observation-limits.js';
import type { NativeExecOutcome } from '../../packages/adapters/src/native-ssh-exec.js';
import type { NativePtyOutcome } from '../../packages/adapters/src/native-ssh-pty.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';

const analyzer = new BashAnalyzer();
const suWrap = async (): Promise<string> => {
  const wrapped = suPtyCommand(await analyzer.analyze('systemctl restart nginx'), '/srv');
  if (!wrapped) throw new Error('fixture wrap failed');
  return wrapped;
};

function fixture(exitCode = 0) {
  const prepareCommandProgram = vi.fn(), openPipe = vi.fn();
  const execFixed = vi.fn(async () => ({ exitCode, output: '' }));
  const runNativeExec = vi.fn(async (_id: string, _input: unknown, _current: () => boolean,
    hooks: { stdout(data: Buffer): void; stderr(data: Buffer): void }) => {
    hooks.stdout(Buffer.from('uid=1000\n'));
    return { state: 'exited' as const, exitCode: 0 };
  });
  const transport = { connectionGeneration: () => 1, prepareCommandProgram, openPipe, execFixed, runNativeExec } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(transport, 'host');
  const exited = vi.fn(), output = vi.fn(), failure = vi.fn();
  terminal.onExit(exited); terminal.onData(output); terminal.onExecutionFailure(failure);
  return { terminal, prepareCommandProgram, openPipe, execFixed, runNativeExec, exited, output, failure };
}

it('routes reviewed foreground commands through native SSH with no Python or SFTP', async () => {
  const f = fixture();
  await f.terminal.execute('id -u', '/', () => true, { executionChannel: 'native-exec' });
  expect(f.runNativeExec).toHaveBeenCalledWith('host', { command: 'id -u', cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh' }, expect.any(Function), expect.any(Object), expect.any(AbortSignal));
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  expect(f.output).toHaveBeenCalledWith('uid=1000\n');
  expect(f.prepareCommandProgram).not.toHaveBeenCalled(); expect(f.openPipe).not.toHaveBeenCalled();
});

it('fails before business dispatch if the remote native tools are absent', async () => {
  const f = fixture(1);
  await f.terminal.execute('id -u', '/', () => true, { executionChannel: 'native-exec' });
  expect(f.runNativeExec).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledWith({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('rejects a changed command rather than falling back to the Python wrapper', async () => {
  const f = fixture();
  await expect(f.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-exec' }))
    .rejects.toThrow('no longer matches');
  expect(f.runNativeExec).not.toHaveBeenCalled(); expect(f.prepareCommandProgram).not.toHaveBeenCalled();
});

it('ends the bounded run window with unknown guidance while the native exec keeps observing', async () => {
  const originalWindow = OBSERVATION_LIMITS.runWindowMs;
  Object.defineProperty(OBSERVATION_LIMITS, 'runWindowMs', { value: 25, configurable: true });
  try {
    let settle!: (outcome: NativeExecOutcome) => void;
    const runNativeExec = vi.fn(() => new Promise<NativeExecOutcome>((resolve) => { settle = resolve; }));
    const transport = { connectionGeneration: () => 1, execFixed: vi.fn(async () => ({ exitCode: 0, output: '' })),
      runNativeExec } as unknown as CommandTransport;
    const terminal = new SshCommandTerminal(transport, 'host');
    const data = vi.fn(), exited = vi.fn(), expired = vi.fn();
    terminal.onData(data); terminal.onExit(exited); terminal.onObservationTimeout(expired);
    const executing = terminal.execute('id -u', '/', () => true, { executionChannel: 'native-exec' });
    await vi.waitFor(() => expect(runNativeExec).toHaveBeenCalledOnce(), { timeout: 15_000 });
    await vi.waitFor(() => expect(expired).toHaveBeenCalledOnce(), { timeout: 15_000 });
    expect(exited).not.toHaveBeenCalled();
    expect(data).toHaveBeenCalledWith('运行期观察窗口到期：远端命令仍在执行，本次调用不再等待其退出；结果未知，不会重放命令，请核验原操作。');
    settle({ state: 'exited', exitCode: 0 });
    await executing;
    expect(exited).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    Object.defineProperty(OBSERVATION_LIMITS, 'runWindowMs', { value: originalWindow, configurable: true });
  }
});

it('clears the run window once the native exec outcome is observed', async () => {
  const originalWindow = OBSERVATION_LIMITS.runWindowMs;
  Object.defineProperty(OBSERVATION_LIMITS, 'runWindowMs', { value: 25, configurable: true });
  try {
    const runNativeExec = vi.fn(async () => ({ state: 'exited' as const, exitCode: 0 }));
    const transport = { connectionGeneration: () => 1, execFixed: vi.fn(async () => ({ exitCode: 0, output: '' })),
      runNativeExec } as unknown as CommandTransport;
    const terminal = new SshCommandTerminal(transport, 'host');
    const data = vi.fn(), expired = vi.fn();
    terminal.onData(data); terminal.onObservationTimeout(expired);
    await terminal.execute('id -u', '/', () => true, { executionChannel: 'native-exec' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(expired).not.toHaveBeenCalled();
    expect(data.mock.calls.flat().join('')).not.toContain('运行期观察窗口到期');
  } finally {
    Object.defineProperty(OBSERVATION_LIMITS, 'runWindowMs', { value: originalWindow, configurable: true });
  }
});

type PtyHooks = { data(text: string): void; authentication(event: { id: string; open: boolean }): void };

function ptyFixture(outcome?: NativePtyOutcome) {
  const answer = vi.fn(() => true), write = vi.fn(), resize = vi.fn();
  let settle!: (settled: NativePtyOutcome) => void;
  const result = outcome ? Promise.resolve(outcome) : new Promise<NativePtyOutcome>((resolve) => { settle = resolve; });
  let hooks: PtyHooks | undefined;
  const runNativePty = vi.fn((_hostId: string, _input: unknown, _current: () => boolean, received: PtyHooks,
    _signal: AbortSignal) => { hooks = received; return { result, answer, write, resize }; });
  const transport = { connectionGeneration: () => 1, runNativePty } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(transport, 'host');
  const exited = vi.fn(), output = vi.fn(), failure = vi.fn(), authentication = vi.fn();
  terminal.onExit(exited); terminal.onData(output); terminal.onExecutionFailure(failure); terminal.onAuthentication(authentication);
  return { terminal, runNativePty, answer, write, resize, exited, output, failure, authentication, settle, hooks: () => hooks! };
}

it('rebuilds one literal sudo command with the client-owned marker prompt on the native PTY', async () => {
  const f = ptyFixture({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
  await f.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(f.runNativePty).toHaveBeenCalledExactlyOnceWith('host', expect.objectContaining({
    command: expect.stringMatching(/^sudo -k -p '\rcloudhelm:[a-f0-9]{32} password: ' 'id'$/u),
    cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh',
    nonce: expect.stringMatching(/^[a-f0-9]{32}$/u), cols: 100, rows: 30 }),
  expect.any(Function), expect.any(Object), expect.any(AbortSignal));
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
});

it('translates marker windows into sudo challenges and routes only answers to open windows', async () => {
  const f = ptyFixture();
  const executing = f.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  await vi.waitFor(() => expect(f.runNativePty).toHaveBeenCalledOnce());
  const hooks = f.hooks();
  hooks.authentication({ id: 'not-a-window', open: true });
  expect(f.authentication).not.toHaveBeenCalled();
  const id = 'a'.repeat(32);
  hooks.authentication({ id, open: true });
  expect(f.authentication).toHaveBeenCalledExactlyOnceWith({ id, prompt: 'sudo 身份验证' });
  hooks.data('uid=0(root) gid=0(root)\n');
  expect(f.output).toHaveBeenCalledExactlyOnceWith('uid=0(root) gid=0(root)\n');
  expect(f.terminal.answerAuthentication('b'.repeat(32), 'pw'), 'unknown window').toBe(false);
  expect(f.terminal.answerAuthentication(id, 'a\nb'), 'multiline answer').toBe(false);
  expect(f.terminal.answerAuthentication(id, 'pw')).toBe(true);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(id, 'pw');
  f.terminal.write('\u0003');
  f.terminal.resize(120, 40);
  expect(f.write).toHaveBeenCalledExactlyOnceWith('\u0003');
  expect(f.resize).toHaveBeenCalledExactlyOnceWith(120, 40);
  hooks.authentication({ id, open: false });
  expect(f.authentication).toHaveBeenNthCalledWith(2, { id });
  expect(f.terminal.answerAuthentication(id, 'pw')).toBe(false);
  f.settle({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
  await executing;
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
});

it('keeps missing-sudo text as inference, not zero-effects proof', async () => {
  const missing = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: true });
  await missing.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(missing.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'unsupported', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(missing.exited).toHaveBeenCalledExactlyOnceWith(127);

  const child = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: false });
  await child.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(child.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(child.exited).toHaveBeenCalledExactlyOnceWith(127);
});

it('does not infer no effects from exit 125 or a missing prompt marker', async () => {
  const denied = ptyFixture({ state: 'exited', exitCode: 125, markerSeen: false, sudoMissing: false });
  await denied.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(denied.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(denied.exited).toHaveBeenCalledExactlyOnceWith(125);

  const marked = ptyFixture({ state: 'exited', exitCode: 125, markerSeen: true, sudoMissing: false });
  await marked.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(marked.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(marked.exited).toHaveBeenCalledExactlyOnceWith(125);
});

it('retains sudoers diagnostics without claiming trusted startup evidence', async () => {
  const denied = ptyFixture({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, sudoDenied: true });
  await denied.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(denied.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'authentication-failed', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'sudo', stage: 'authorization', code: 'authorization-denied', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(denied.exited).toHaveBeenCalledExactlyOnceWith(1);

  // A prompt marker cannot upgrade diagnostic text to trusted startup evidence.
  // Its absence is not evidence that no payload ran either.
  const unproven = ptyFixture({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false });
  await unproven.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(unproven.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(unproven.exited).toHaveBeenCalledExactlyOnceWith(1);

  const unmarked = ptyFixture({ state: 'exited', exitCode: 1, markerSeen: false, sudoMissing: false, sudoDenied: true });
  await unmarked.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(unmarked.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'authentication-failed', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'sudo', stage: 'authorization', code: 'authorization-denied', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(unmarked.exited).toHaveBeenCalledExactlyOnceWith(1);
});

it('settles unknown outcomes without replaying and fails closed without the native PTY transport', async () => {
  const unknown = ptyFixture({ state: 'unknown', reason: 'aborted' });
  await unknown.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(unknown.output).toHaveBeenCalledExactlyOnceWith('原生 SSH 命令结果未知；请核验原操作，不要直接重放。');
  expect(unknown.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(unknown.failure).not.toHaveBeenCalled();

  const legacy = { connectionGeneration: () => 1 } as unknown as CommandTransport;
  const terminal = new SshCommandTerminal(legacy, 'host');
  const exited = vi.fn(), failure = vi.fn();
  terminal.onExit(exited); terminal.onExecutionFailure(failure);
  await terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
  expect(exited).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('rejects a changed sudo form rather than dispatching an unreviewed rebuild', async () => {
  for (const command of ['id -u', 'sudo -p "x" id', 'sudo id | cat', 'sudo id; sudo whoami']) {
    const f = ptyFixture();
    await expect(f.terminal.execute(command, '/', () => true, { executionChannel: 'native-pty' }), command)
      .rejects.toThrow('no longer matches');
    expect(f.runNativePty, command).not.toHaveBeenCalled();
  }
});

it('aborts the in-flight PTY session when the terminal closes', async () => {
  const f = ptyFixture();
  const executing = f.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  await vi.waitFor(() => expect(f.runNativePty).toHaveBeenCalledOnce());
  const signal = f.runNativePty.mock.calls[0]![4];
  f.terminal.close();
  expect(signal.aborted).toBe(true);
  f.settle({ state: 'unknown', reason: 'aborted' });
  await executing;
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('dispatches the backend-built su wrap on the su-window PTY with a one-time marker prefix', async () => {
  const f = ptyFixture({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false });
  const wrapped = await suWrap();
  const executing = f.terminal.execute(wrapped, '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  await vi.waitFor(() => expect(f.runNativePty).toHaveBeenCalledOnce());
  expect(f.runNativePty).toHaveBeenCalledExactlyOnceWith('host', expect.objectContaining({
    command: expect.stringMatching(/^printf '%s' 'cloudhelm:[a-f0-9]{32}'; su -l -s \/bin\/sh root -c /u),
    cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh', window: 'su-window',
    nonce: expect.stringMatching(/^[a-f0-9]{32}$/u) }),
  expect.any(Function), expect.any(Object), expect.any(AbortSignal));
  const hooks = f.hooks();
  const id = 'c'.repeat(32);
  hooks.authentication({ id, open: true });
  expect(f.authentication).toHaveBeenCalledExactlyOnceWith({ id, prompt: 'su 身份验证' });
  hooks.data('uid=0(root)\n');
  expect(f.output).toHaveBeenCalledExactlyOnceWith('uid=0(root)\n');
  await executing;
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
});

it('keeps su failure text unconfirmed and preserves successful exits', async () => {
  const rejected = ptyFixture({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, suAuthenticationFailed: true });
  await rejected.terminal.execute(await suWrap(), '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  expect(rejected.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'authentication-failed', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'su', stage: 'authentication', code: 'authentication-rejected', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(rejected.exited).toHaveBeenCalledExactlyOnceWith(1);

  // A payload echoing the failure text but exiting 0 must never pause the task.
  const echoed = ptyFixture({ state: 'exited', exitCode: 0, markerSeen: true, sudoMissing: false, suAuthenticationFailed: true });
  await echoed.terminal.execute(await suWrap(), '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  expect(echoed.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  expect(echoed.exited).toHaveBeenCalledExactlyOnceWith(0);
});

it('classifies a missing su or unknown target account as unsupported, passing business exits through', async () => {
  const missing = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: true, sudoMissing: false, suMissing: true });
  await missing.terminal.execute(await suWrap(), '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  expect(missing.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'unsupported', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'su', stage: 'preparation', code: 'unsupported', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(missing.exited).toHaveBeenCalledExactlyOnceWith(127);

  const user = ptyFixture({ state: 'exited', exitCode: 1, markerSeen: true, sudoMissing: false, suUserMissing: true });
  await user.terminal.execute(await suWrap(), '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  expect(user.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'unsupported', effects: 'possible',
    handoff: 'handed-off',
    privilege: { method: 'su', stage: 'preparation', code: 'unsupported', source: 'output-inference',
      businessCommand: 'unknown', recovery: 'verify' } });
  expect(user.exited).toHaveBeenCalledExactlyOnceWith(1);

  // A business-level 127 without su diagnostics is an ordinary failed command.
  const business = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: true, sudoMissing: false });
  await business.terminal.execute(await suWrap(), '/srv', () => true, { executionChannel: 'native-pty', sudoAuthorization: true });
  expect(business.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off' });
  expect(business.exited).toHaveBeenCalledExactlyOnceWith(127);
});

it('rejects agent-supplied su forms and unprivileged wraps on the native PTY route', async () => {
  for (const command of [await suWrap(), 'su root', `su -l -s /bin/sh root -c 'id'`]) {
    const f = ptyFixture();
    await expect(f.terminal.execute(command, '/', () => true, { executionChannel: 'native-pty' }), command)
      .rejects.toThrow('no longer matches');
    expect(f.runNativePty, command).not.toHaveBeenCalled();
  }
  const wrongChannel = ptyFixture();
  await expect(wrongChannel.terminal.execute(await suWrap(), '/srv', () => true,
    { executionChannel: 'native-exec', sudoAuthorization: true })).rejects.toThrow('no longer matches');
  expect(wrongChannel.runNativePty).not.toHaveBeenCalled();
});
