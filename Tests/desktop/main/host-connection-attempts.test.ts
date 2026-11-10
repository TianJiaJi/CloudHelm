import { expect, it, vi } from 'vitest';
import { HostConnectionAttempts } from '../../../apps/desktop/src/main/host-connection-attempts.js';
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
it('deduplicates one current connection intent and releases it after settlement', async () => {
  const attempts = new HostConnectionAttempts(), connect = vi.fn(async () => {});
  const first = attempts.run('host', connect); expect(attempts.run('host', connect)).toBe(first);
  await first; expect(connect).toHaveBeenCalledOnce(); await attempts.run('host', connect); expect(connect).toHaveBeenCalledTimes(2);
});
it('cancels before dispatch without invoking the connection callback', async () => {
  const attempts = new HostConnectionAttempts(), connect = vi.fn(async () => {}), pending = attempts.run('host', connect);
  const rejected = expect(pending).rejects.toThrow('已取消'); attempts.cancel('host'); await rejected;
  expect(connect).not.toHaveBeenCalled();
});
it('cancels a target immediately while awaiting a jump and prevents late target dispatch', async () => {
  const attempts = new HostConnectionAttempts(), jump = deferred(), entered = deferred(), dispatch = vi.fn();
  let finished!: Promise<void>;
  const target = attempts.run('target', async (signal) => {
    finished = jump.promise.then(() => { signal.throwIfAborted(); dispatch(); }); entered.release(); await finished;
  });
  await entered.promise; const rejected = expect(target).rejects.toThrow('已取消');
  attempts.cancel('target'); await rejected; jump.release(); await expect(finished).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});
it('does not let late settlement delete a newer connection intent', async () => {
  const attempts = new HostConnectionAttempts(), oldGate = deferred(), newGate = deferred();
  const old = attempts.run('host', () => oldGate.promise); await Promise.resolve();
  const rejected = expect(old).rejects.toThrow('已取消'); attempts.cancel('host');
  const next = attempts.run('host', () => newGate.promise); await rejected;
  oldGate.release(); await oldGate.promise; await Promise.resolve();
  const duplicate = vi.fn(async () => {}); expect(attempts.run('host', duplicate)).toBe(next);
  newGate.release(); await next; expect(duplicate).not.toHaveBeenCalled();
});
it('does not cancel an independently shared jump connection', async () => {
  const attempts = new HostConnectionAttempts(), gate = deferred(); let jumpSignal!: AbortSignal;
  const jump = attempts.run('jump', async (signal) => { jumpSignal = signal; await gate.promise; });
  const target = attempts.run('target', async (signal) => { await jump; signal.throwIfAborted(); });
  await Promise.resolve(); const rejected = expect(target).rejects.toThrow('已取消'); attempts.cancel('target'); await rejected;
  expect(jumpSignal.aborted).toBe(false); gate.release(); await jump;
});
