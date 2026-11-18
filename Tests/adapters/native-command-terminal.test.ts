import { expect, it, vi } from 'vitest';
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
