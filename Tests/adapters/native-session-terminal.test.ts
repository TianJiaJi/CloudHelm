import { describe, expect, it, vi } from 'vitest';
import { SUDO_SESSION_PROMPT } from '@cloudhelm/core';
import type { NativeExecOutcome } from '../../packages/adapters/src/native-ssh-exec.js';
import { NativeSessionTerminal, type SessionTransport, type SudoSessionChannel } from '../../packages/adapters/src/native-session-terminal.js';

interface ExecInput { command: string; cwd: string; envPath: string; shellPath: string }
interface ExecHooks {
  stdout(data: Buffer): void; stderr(data: Buffer): void;
  stdin?(write: (data: Buffer) => void, end: () => void): void;
}
interface RecordedDispatch { input: ExecInput; signal?: AbortSignal; written: Buffer[]; endStdin(): void; stdinEnded(): boolean; hooks: ExecHooks }

function fixture(sudoChannel: SudoSessionChannel | undefined,
  script: (dispatch: RecordedDispatch) => Promise<NativeExecOutcome> | NativeExecOutcome | void = () => {}) {
  const dispatches: RecordedDispatch[] = [];
  const execFixed = vi.fn(async () => ({ exitCode: 0, output: '' }));
  const runNativeExec = vi.fn(async (_hostId: string, input: ExecInput, _authorized: () => boolean, hooks: ExecHooks, signal?: AbortSignal): Promise<NativeExecOutcome> => {
    const dispatch: RecordedDispatch = { input, signal, written: [], endStdin: () => { ended = true; }, stdinEnded: () => ended, hooks };
    let ended = false;
    dispatches.push(dispatch);
    hooks.stdin?.((data: Buffer) => { dispatch.written.push(data); }, dispatch.endStdin);
    return (await script(dispatch)) ?? { state: 'exited', exitCode: 0 };
  });
  const transport: SessionTransport = { connectionGeneration: () => 1, execFixed, runNativeExec };
  const terminal = new NativeSessionTerminal(transport, 'host', sudoChannel);
  const data = vi.fn(); const failure = vi.fn(); const exited = vi.fn();
  terminal.onData(data); terminal.onExecutionFailure(failure); terminal.onExit(exited);
  return { terminal, dispatches, execFixed, runNativeExec, data, failure, exited };
}

const channel = (password?: string) => {
  const credential = vi.fn(async () => password);
  const rejected = vi.fn();
  return { channel: { credential, rejected }, credential, rejected } as const;
};

describe('native session terminal', () => {
  it('dispatches reviewed commands verbatim on a root-login session without any credential flow', async () => {
    const f = fixture(undefined);
    await f.terminal.execute('systemctl restart nginx', '/srv', () => true);
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]!.input).toMatchObject({ command: 'systemctl restart nginx', cwd: '/srv' });
    expect(f.dispatches[0]!.written).toEqual([]);
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  });

  it('rebuilds the sudo form for stdin injection and keeps the password out of command text', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel);
    await f.terminal.execute('sudo systemctl restart nginx', '/srv', () => true);
    expect(f.dispatches[0]!.input.command).toBe(`sudo -k -S -p '${SUDO_SESSION_PROMPT}' 'systemctl' 'restart' 'nginx'`);
    expect(JSON.stringify(f.dispatches[0]!.input)).not.toContain('session-secret');
    expect(f.dispatches[0]!.written).toEqual([Buffer.from('session-secret\n', 'utf8')]);
    expect(c.credential).toHaveBeenCalledExactlyOnceWith({ command: 'sudo systemctl restart nginx' });
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
  });

  it('never dispatches when the user declines the session password', async () => {
    const c = channel(undefined);
    const f = fixture(c.channel);
    await f.terminal.execute('sudo id', '/', () => true);
    expect(f.runNativeExec).not.toHaveBeenCalled();
    expect(c.rejected).toHaveBeenCalledOnce();
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'not-dispatched', effects: 'none', requiresUserAction: true,
      handoff: 'not-sent', businessStart: 'not-started',
      privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-unconfirmed',
        source: 'transport', businessCommand: 'not-started', recovery: 'user-action' } });
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('ends stdin and fails closed when sudo challenges for the password a second time', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel, ({ hooks }) => {
      hooks.stderr(Buffer.from(SUDO_SESSION_PROMPT));
      hooks.stderr(Buffer.from(SUDO_SESSION_PROMPT));
      return { state: 'exited', exitCode: 1 };
    });
    await f.terminal.execute('sudo id', '/', () => true);
    expect(f.dispatches[0]!.stdinEnded()).toBe(true);
    expect(f.dispatches[0]!.written).toHaveLength(1);
    expect(c.rejected).toHaveBeenCalledOnce();
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'authentication-failed', effects: 'possible',
      handoff: 'handed-off',
      privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-rejected',
        source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' } });
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('drops the cached credential when sudo reports an authentication failure', async () => {
    const c = channel('wrong-secret');
    const f = fixture(c.channel, ({ hooks }) => {
      hooks.stderr(Buffer.from(SUDO_SESSION_PROMPT));
      hooks.stderr(Buffer.from('sudo: 1 incorrect password attempt\n'));
      return { state: 'exited', exitCode: 1 };
    });
    await f.terminal.execute('sudo id', '/', () => true);
    expect(c.rejected).toHaveBeenCalledOnce();
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'authentication-failed', effects: 'possible',
      handoff: 'handed-off',
      privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-rejected',
        source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' } });
  });

  it('does not turn a successful payload echoing authentication text into a failure', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel, ({ hooks }) => {
      hooks.stderr(Buffer.from(`${SUDO_SESSION_PROMPT}${SUDO_SESSION_PROMPT}authentication failure\n`));
      return { state: 'exited', exitCode: 0 };
    });
    await f.terminal.execute('sudo id', '/', () => true);
    expect(c.rejected).toHaveBeenCalledOnce(); // Defensive cache cleanup, not business failure proof.
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ handoff: 'handed-off', businessStart: 'started' });
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refuses to dispatch when the host lacks the fixed native tooling', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel);
    f.execFixed.mockResolvedValueOnce({ exitCode: 127, output: '' });
    await f.terminal.execute('sudo id', '/', () => true);
    expect(f.runNativeExec).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledExactlyOnceWith({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
    expect(f.data.mock.calls.flat().join('')).toContain('/usr/bin/env');
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('aborts the dispatch channel on Ctrl+C and reports an unknown outcome without replay', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel, ({ signal }) => new Promise<NativeExecOutcome>((resolve) => {
      signal?.addEventListener('abort', () => resolve({ state: 'unknown', reason: 'aborted' }), { once: true });
    }));
    const pending = f.terminal.execute('sudo id', '/', () => true);
    await vi.waitFor(() => expect(f.dispatches).toHaveLength(1));
    f.terminal.write('\u0003');
    await pending;
    expect(f.exited).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.data.mock.calls.flat().join('')).toContain('结果未知');
  });

  it('refuses session sudo forms that cannot be rebuilt for stdin injection', async () => {
    const c = channel('session-secret');
    const f = fixture(c.channel);
    await expect(f.terminal.execute('sudo id | cat', '/', () => true)).rejects.toThrow('cannot be rebuilt');
    await expect(f.terminal.execute('sudo -n id', '/', () => true)).rejects.toThrow('cannot be rebuilt');
    expect(f.runNativeExec).not.toHaveBeenCalled();
    expect(c.credential).not.toHaveBeenCalled();
  });
});
