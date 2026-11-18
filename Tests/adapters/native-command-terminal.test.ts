import { expect, it, vi } from 'vitest';
import type { NativePtyOutcome } from '../../packages/adapters/src/native-ssh-pty.js';
import { SshCommandTerminal, type CommandTransport } from '../../packages/adapters/src/ssh-command-terminal.js';

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
  expect(f.output).toHaveBeenCalledWith('uid=1000\n');
  expect(f.prepareCommandProgram).not.toHaveBeenCalled(); expect(f.openPipe).not.toHaveBeenCalled();
});

it('fails before business dispatch if the remote native tools are absent', async () => {
  const f = fixture(1);
  await f.terminal.execute('id -u', '/', () => true, { executionChannel: 'native-exec' });
  expect(f.runNativeExec).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledWith({ failureKind: 'not-dispatched', effects: 'none' });
  expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('rejects a changed command rather than falling back to the Python wrapper', async () => {
  const f = fixture();
  await expect(f.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-exec' }))
    .rejects.toThrow('no longer matches');
  expect(f.runNativeExec).not.toHaveBeenCalled(); expect(f.prepareCommandProgram).not.toHaveBeenCalled();
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
  expect(f.failure).not.toHaveBeenCalled();
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

it('reports a shell-missing sudo as sudo-unavailable without mistaking sudo\'s own child diagnostic', async () => {
  const missing = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: true });
  await missing.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(missing.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'unsupported', effects: 'none',
    privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable', source: 'transport',
      businessCommand: 'not-started', recovery: 'confirm-alternative' } });
  expect(missing.exited).toHaveBeenCalledExactlyOnceWith(127);

  const child = ptyFixture({ state: 'exited', exitCode: 127, markerSeen: false, sudoMissing: false });
  await child.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(child.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'unsupported', effects: 'none' });
  expect(child.exited).toHaveBeenCalledExactlyOnceWith(127);
});

it('distinguishes a failed directory change from sudo-driven 125 exits', async () => {
  const denied = ptyFixture({ state: 'exited', exitCode: 125, markerSeen: false, sudoMissing: false });
  await denied.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(denied.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'permission-denied', effects: 'none' });
  expect(denied.exited).toHaveBeenCalledExactlyOnceWith(125);

  const marked = ptyFixture({ state: 'exited', exitCode: 125, markerSeen: true, sudoMissing: false });
  await marked.terminal.execute('sudo id', '/', () => true, { executionChannel: 'native-pty' });
  expect(marked.failure).not.toHaveBeenCalled();
  expect(marked.exited).toHaveBeenCalledExactlyOnceWith(125);
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
  expect(failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'not-dispatched', effects: 'none' });
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
