import type { Client, ClientChannel } from 'ssh2';
import { OBSERVATION_LIMITS } from '@cloudhelm/core';
import { renderNativeExecCommand } from './native-exec-command.js';

export type NativeExecOutcome =
  | { state: 'not-dispatched'; reason: 'authorization-expired' }
  | { state: 'exited'; exitCode: number }
  | { state: 'signaled'; signal: string; coreDumped: boolean }
  | { state: 'unknown'; reason: 'allocation' | 'timeout' | 'aborted' | 'channel-error' | 'missing-exit' | 'authorization-expired' | 'output-limit' };

/** One SSH exec request. Channel closure/abort is never proof of process exit.
 * The caller must persist authorization before calling this function and must
 * treat every unknown outcome as possibly dispatched, never retry it. */
export function runNativeSshExec(client: Pick<Client, 'exec'>, input: {
  command: string; cwd: string; envPath: string; shellPath: string;
}, current: () => boolean, hooks: {
  stdout(data: Buffer): void; stderr(data: Buffer): void;
  /** Claim immediately before the one business exec; never consult it after handoff. */
  claimStart?(): boolean;
  /** Optional one-shot stdin handoff, invoked after the channel is open and
   * re-authorized and before any output is delivered. The writer stays valid
   * until the outcome settles; later writes are dropped. */
  stdin?(write: (data: Buffer) => void, end: () => void): void;
}, signal?: AbortSignal, startupTimeoutMs: number = OBSERVATION_LIMITS.channelAllocationMs): Promise<NativeExecOutcome> {
  const rendered = renderNativeExecCommand(input);
  if (signal?.aborted || !current()) return Promise.resolve({ state: 'not-dispatched', reason: 'authorization-expired' });
  return new Promise((resolve) => {
    let channel: ClientChannel | undefined, settled = false, requested = false, outputBytes = 0;
    let exit: NativeExecOutcome | undefined;
    const finish = (outcome: NativeExecOutcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { channel?.close(); } catch { /* No assumption that the remote process stopped. */ }
      resolve(outcome);
    };
    const abort = () => finish(requested ? { state: 'unknown', reason: 'aborted' }
      : { state: 'not-dispatched', reason: 'authorization-expired' });
    const timer = setTimeout(() => finish({ state: 'unknown', reason: 'timeout' }), startupTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || !current()) { finish({ state: 'not-dispatched', reason: 'authorization-expired' }); return; }
    try {
      let claimed = true;
      try { claimed = hooks.claimStart?.() !== false; } catch { claimed = false; }
      if (!claimed) { finish({ state: 'not-dispatched', reason: 'authorization-expired' }); return; }
      requested = true;
      client.exec(rendered, { pty: false }, (error, stream) => {
        if (settled) {
          stream?.on('error', () => {}); stream?.stderr.on('error', () => {});
          try { stream?.close(); } catch { /* Already unknown. */ }
          return;
        }
        channel = stream;
        if (error || !stream) { finish({ state: 'unknown', reason: 'allocation' }); return; }
        clearTimeout(timer);
        if (!current()) { finish({ state: 'unknown', reason: 'authorization-expired' }); return; }
        const deliver = (data: Buffer, output: (chunk: Buffer) => void) => {
          if (settled) return;
          if (!current()) { finish({ state: 'unknown', reason: 'authorization-expired' }); return; }
          outputBytes += data.length;
          if (outputBytes > OBSERVATION_LIMITS.execOutputLimitBytes) { finish({ state: 'unknown', reason: 'output-limit' }); return; }
          try { output(Buffer.from(data)); } catch { finish({ state: 'unknown', reason: 'channel-error' }); }
        };
        stream.on('data', (data: Buffer) => deliver(data, hooks.stdout));
        stream.stderr.on('data', (data: Buffer) => deliver(data, hooks.stderr));
        stream.stderr.on('error', () => finish({ state: 'unknown', reason: 'channel-error' }));
        stream.on('error', () => finish({ state: 'unknown', reason: 'channel-error' }));
        if (hooks.stdin) {
          try {
            hooks.stdin((data) => { if (!settled) { try { stream.write(data); } catch { finish({ state: 'unknown', reason: 'channel-error' }); } } },
              () => { if (!settled) { try { stream.end(); } catch { /* The close outcome stays authoritative. */ } } });
          } catch { finish({ state: 'unknown', reason: 'channel-error' }); }
        }
        stream.on('exit', (code: number | null, name?: string, coreDumped?: boolean) => {
          exit = Number.isInteger(code) && code !== null && code >= 0 && code <= 255
            ? { state: 'exited', exitCode: code }
            : typeof name === 'string' && /^[A-Z0-9]{1,24}$/u.test(name)
              ? { state: 'signaled', signal: name, coreDumped: coreDumped === true }
              : undefined;
        });
        stream.on('close', () => finish(!current() ? { state: 'unknown', reason: 'authorization-expired' }
          : exit ?? { state: 'unknown', reason: 'missing-exit' }));
      });
    } catch { finish({ state: 'unknown', reason: 'allocation' }); }
  });
}
