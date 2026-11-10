import type { Client, ClientChannel, ExecOptions } from 'ssh2';

/** Bounded startup, not command replay. A lost SSH acknowledgment cannot prove
 * that the remote initialization did not run. Late channels are closed, never adopted. */
export function openManualChannel(client: Client, command: string, options: ExecOptions,
  assertAuthorized: () => void, signal?: AbortSignal): Promise<ClientChannel> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false, attempted = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(new Error(attempted ? '人工终端启动已取消；远端可能已经收到请求，请核对状态' : '人工终端启动已取消，配置命令未发送'));
    const timer = setTimeout(() => fail(new Error('人工终端启动结果未确认，请检查远端状态；不会自动重试')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      assertAuthorized(); attempted = true;
      client.exec(command, options, (error, channel) => {
        if (settled) { channel?.close(); return; }
        if (error) { fail(error); return; }
        settled = true; cleanup(); resolve(channel);
      });
    } catch (error) { fail(error instanceof Error ? error : new Error('人工终端启动失败')); }
  });
}
