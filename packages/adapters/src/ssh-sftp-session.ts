import type { Client, SFTPWrapper } from 'ssh2';

function endChannel(channel?: SFTPWrapper): void {
  try { channel?.end(); } catch { /* Local authority stays revoked even if shutdown fails. */ }
}

/** Each SFTP action owns a channel, not the SSH connection. Expiry revokes all later I/O. */
export async function withSftpSession<T>(client: Pick<Client, 'sftp'>,
  action: (sftp: SFTPWrapper, assertActive: () => void) => Promise<T>,
  options: { signal?: AbortSignal; isCurrent?: () => boolean; timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid SFTP deadline');
  options.signal?.throwIfAborted();
  let closed = false, channel: SFTPWrapper | undefined;
  const assertActive = () => {
    if (closed || options.signal?.aborted) throw new Error('SFTP operation is no longer active');
    if (options.isCurrent && !options.isCurrent()) throw new Error('SFTP connection changed');
  };
  let rejectLifetime!: (error: Error) => void;
  const lifetime = new Promise<never>((_resolve, reject) => { rejectLifetime = reject; });
  const stop = (error: Error) => {
    if (closed) return;
    closed = true; rejectLifetime(error);
  };
  const abort = () => stop(new Error('SFTP operation canceled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Error('SFTP operation deadline exceeded')), timeoutMs);
  timer.unref();
  const work = (async () => {
    assertActive();
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      let received = false;
      client.sftp((error, instance) => {
        if (received || closed) { endChannel(instance); if (!received) reject(new Error('SFTP channel opened after expiry')); return; }
        received = true;
        if (error) { reject(error); return; }
        channel = instance;
        // Retain the error handler through channel shutdown so a late transport error
        // cannot become an unhandled EventEmitter error after local cancellation.
        instance.on('error', (failure: Error) => stop(failure));
        instance.once('close', () => stop(new Error('SFTP channel closed')));
        resolve(instance);
      });
    });
    assertActive();
    return action(sftp, assertActive);
  })();
  try { return await Promise.race([work, lifetime]); }
  finally {
    closed = true;
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    endChannel(channel);
  }
}
