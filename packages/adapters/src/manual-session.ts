import type { Client, ClientChannel } from 'ssh2';
import type { SshConnectionSettings } from '@cloudhelm/core';

type Session = NonNullable<SshConnectionSettings['session']>;
const quote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;

/** Only explicit human-session callers may use this prelude. AI transports do not. */
export function manualSessionStartup(session?: Session): string {
  if (!session) return '';
  const environment = (session.environment ?? []).map(({ name, value }) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name.startsWith('CLOUDHELM_') || /[\u0000\r\n]/u.test(value)) throw new Error('Invalid manual-session environment');
    return `export ${name}=${quote(value)}`;
  });
  const dir = session.directory;
  if (dir && /[\u0000\r\n]/u.test(dir)) throw new Error('Invalid manual-session directory');
  const path = dir === '~' ? '"$HOME"' : dir?.startsWith('~/') ? `"$HOME"/${quote(dir.slice(2))}` : dir ? quote(dir) : '';
  const directory = path ? `cd -- ${path} || { printf '%s\\n' 'CloudHelm: configured directory is unavailable' >&2; exit 1; }` : '';
  return [...environment, directory, session.initialization ? `eval ${quote(session.initialization)}` : ''].filter(Boolean).join('\n');
}

/** Not an SSH protocol heartbeat: an explicitly approved human command on an
 * independent, non-PTY channel. Never writes into the foreground program's stdin.
 * Nonzero exit, transport failure, missing exit status and timeout stop the schedule;
 * none of those outcomes is retried. Closing a channel does not prove process exit. */
export function startManualKeepalive(client: Client, session: Session | undefined,
  assertAuthorized: () => void, canRun: () => boolean, notice: (message: string) => void): () => void {
  if (!session?.keepaliveCommand?.trim()) return () => {};
  const interval = session.keepaliveIntervalMs;
  if (!interval || interval < 10_000 || interval > 3_600_000) throw new Error('Invalid manual keepalive interval');
  const command = `/bin/sh -c ${quote(`${manualSessionStartup({ directory: session.directory, environment: session.environment })}\n${session.keepaliveCommand}`)}`;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let active: ClientChannel | undefined;
  const stop = () => {
    stopped = true; if (timer) clearTimeout(timer); if (deadline) clearTimeout(deadline);
    active?.close(); active = undefined;
  };
  const failed = () => {
    if (stopped) return;
    stop(); notice('自定义保活命令已停止：执行失败或结果未确认。请先核对远端状态，不会自动重试。');
  };
  const schedule = () => { if (!stopped) { timer = setTimeout(tick, interval); timer.unref(); } };
  const tick = () => {
    if (stopped) return;
    try {
      assertAuthorized();
      if (!canRun()) { schedule(); return; }
      deadline = setTimeout(failed, 15_000); deadline.unref();
      client.exec(command, (error, channel) => {
        if (stopped) { channel?.close(); return; }
        if (error) { failed(); return; }
        active = channel; let exitCode: number | undefined;
        // A signal/unknown exit is not success, even if output happens to look positive.
        channel.on('exit', (code: number | null) => { exitCode = typeof code === 'number' ? code : undefined; });
        channel.on('error', failed);
        channel.on('close', () => {
          active = undefined; if (deadline) clearTimeout(deadline);
          if (stopped) return;
          if (exitCode !== 0) { failed(); return; }
          schedule();
        });
        channel.resume(); channel.stderr.resume(); channel.end();
      });
    } catch { failed(); }
  };
  schedule(); return stop;
}
