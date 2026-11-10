import type { Client, ClientChannel } from 'ssh2';

/** Allocate a fixed control channel with a deadline covering client.exec itself.
 * Never retries. Timeout closes late channels; it says nothing about remote exit. */
export function openSshControlPipe(client: Pick<Client, 'exec'>, command: string, current: () => boolean): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(new Error(message));
    };
    const discard = (channel?: ClientChannel) => {
      channel?.on('error', () => {});
      try { channel?.end(); channel?.close(); } catch { /* No payload or retry. */ }
    };
    const timer = setTimeout(() => fail('SSH 控制通道分配超时（15 秒）'), 15_000);
    if (!current()) { fail('SSH 控制通道的连接代次已变化'); return; }
    try {
      client.exec(command, (error, channel) => {
        if (settled) { discard(channel); return; }
        if (error || !current()) { discard(channel); fail(error ? 'SSH 未接受控制通道请求' : 'SSH 控制通道的连接代次已变化'); return; }
        settled = true; clearTimeout(timer);
        // Consume errors in the handoff microtask before the owner attaches its observer.
        channel.on('error', () => {});
        resolve(channel);
      });
    } catch { fail('SSH 控制通道请求失败'); }
  });
}
