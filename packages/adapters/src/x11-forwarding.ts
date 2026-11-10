import net, { type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Client, ClientChannel, X11Options } from 'ssh2';
import type { SshConnectionSettings } from '@cloudhelm/core';
import { localX11Cookie } from './x11-cookie.js';

type Settings = NonNullable<SshConnectionSettings['x11']>;
interface Binding { fake: Buffer; real: Buffer; display: number; assertCurrent(): void; channels: Set<() => void> }
export interface X11Registration { request: X11Options; dispose(): void }
const protocol = Buffer.from('MIT-MAGIC-COOKIE-1', 'ascii');
const padded = (bytes: Buffer) => { const value = Buffer.alloc((bytes.length + 3) & ~3); bytes.copy(value); return value; };
const brokers = new WeakMap<Client, X11Forwarding>();
const connectLocal = (display: number): Socket => process.platform === 'win32'
  ? net.connect({ host: '127.0.0.1', port: 6000 + display }) : net.connect({ path: `/tmp/.X11-unix/X${display}` });

/** One handler per SSH client, not one handler per shell. A remote channel must
 * prove possession of a per-shell forwarding cookie before any local connection.
 * The real local X cookie never leaves this process toward the SSH server. */
export class X11Forwarding {
  private readonly bindings = new Set<Binding>();
  private readonly pending = new Set<() => void>();
  constructor(client: Client, private readonly connect: (display: number) => Socket = connectLocal) {
    client.on('x11', (_details, accept, reject) => {
      if (!this.bindings.size || this.pending.size >= 16) { reject(); return; }
      this.receive(accept());
    });
    client.once('close', () => {
      for (const close of this.pending) close();
      for (const binding of this.bindings) this.dispose(binding);
    });
  }

  register(settings: Settings, localCookie: Buffer, assertCurrent: () => void): X11Registration {
    assertCurrent();
    if (!settings.enabled || !Number.isInteger(settings.display) || settings.display < 0 || settings.display > 59535
      || !Number.isInteger(settings.screen) || settings.screen < 0 || settings.screen > 255
      || localCookie.length !== (settings.cookie === 'none' ? 0 : 16)) throw new Error('Invalid local X11 forwarding configuration');
    const binding: Binding = { fake: randomBytes(16), real: Buffer.from(localCookie), display: settings.display, assertCurrent, channels: new Set() };
    this.bindings.add(binding);
    return { request: { single: false, screen: settings.screen, protocol: protocol.toString('ascii'), cookie: binding.fake.toString('hex') },
      dispose: () => this.dispose(binding) };
  }

  private dispose(binding: Binding): void {
    this.bindings.delete(binding);
    for (const close of binding.channels) close();
    binding.fake.fill(0); binding.real.fill(0);
  }

  private receive(channel: ClientChannel): void {
    let bytes = Buffer.alloc(0), local: Socket | undefined, binding: Binding | undefined, ended = false;
    const end = () => {
      if (ended) return;
      ended = true; clearTimeout(timer); channel.off('data', data);
      this.pending.delete(end); binding?.channels.delete(end); local?.destroy(); channel.close(); bytes.fill(0);
    };
    const timer = setTimeout(end, 5000); timer.unref(); this.pending.add(end);
    channel.once('close', end); channel.once('error', end);
    const data = (chunk: Buffer) => {
      if (ended) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65_536) { end(); return; }
      if (bytes.length < 12) return;
      const little = bytes[0] === 0x6c;
      if (!little && bytes[0] !== 0x42) { end(); return; }
      const word = (offset: number) => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
      const nameLength = word(6), cookieLength = word(8);
      if (word(2) !== 11 || nameLength !== protocol.length || cookieLength !== 16) { end(); return; }
      const cookieOffset = 12 + ((nameLength + 3) & ~3), total = cookieOffset + ((cookieLength + 3) & ~3);
      if (bytes.length < total) return;
      if (!bytes.subarray(12, 12 + nameLength).equals(protocol)) { end(); return; }
      const presented = bytes.subarray(cookieOffset, cookieOffset + cookieLength);
      binding = [...this.bindings].find((entry) => timingSafeEqual(entry.fake, presented));
      if (!binding) { end(); return; }
      try { binding.assertCurrent(); } catch { end(); return; }
      binding.channels.add(end); channel.off('data', data); channel.pause();
      const name = binding.real.length ? protocol : Buffer.alloc(0), header = Buffer.from(bytes.subarray(0, 12));
      if (little) { header.writeUInt16LE(name.length, 6); header.writeUInt16LE(binding.real.length, 8); }
      else { header.writeUInt16BE(name.length, 6); header.writeUInt16BE(binding.real.length, 8); }
      const packet = Buffer.concat([header, padded(name), padded(binding.real), bytes.subarray(total)]);
      bytes.fill(0); bytes = Buffer.alloc(0);
      try {
        local = this.connect(binding.display);
        local.once('error', () => { packet.fill(0); end(); }); local.once('close', () => { packet.fill(0); end(); });
        local.once('connect', () => {
          if (ended) { packet.fill(0); return; }
          try { binding!.assertCurrent(); } catch { packet.fill(0); end(); return; }
          clearTimeout(timer);
          local!.write(packet, () => packet.fill(0));
          channel.pipe(local!).pipe(channel); channel.resume();
        });
      } catch { packet.fill(0); end(); }
    };
    channel.on('data', data);
  }
}

// Disk-backed Xauthority can be slow or become unavailable. Bound startup even
// then, and wipe a late read rather than creating a forwarding grant after cancel.
function loadCookie(settings: Settings, manual: string | undefined, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(new Error('X11 配置确认已取消，未启用转发'));
    const timer = setTimeout(() => fail(new Error('读取本机 X11 认证信息超时，未启用转发')), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void localX11Cookie(settings.cookie, settings.display, manual).then((cookie) => {
      if (settled) { cookie.fill(0); return; }
      settled = true; cleanup(); resolve(cookie);
    }, fail);
  });
}

export async function prepareX11Forwarding(client: Client, settings: Settings, assertCurrent: () => void, manualCookie?: string, signal?: AbortSignal): Promise<X11Registration> {
  assertCurrent();
  const cookie = await loadCookie(settings, manualCookie, signal);
  try {
    signal?.throwIfAborted(); assertCurrent();
    let broker = brokers.get(client);
    if (!broker) { broker = new X11Forwarding(client); brokers.set(client, broker); }
    return broker.register(settings, cookie, assertCurrent);
  } finally { cookie.fill(0); }
}
