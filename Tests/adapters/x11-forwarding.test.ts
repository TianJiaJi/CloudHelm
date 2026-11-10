import { EventEmitter, once } from 'node:events';
import { Duplex } from 'node:stream';
import net, { type Socket } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Client, Server, utils, type ClientChannel, type ServerChannel, type Connection, type X11Info } from 'ssh2';
import { X11Forwarding } from '../../packages/adapters/src/x11-forwarding.js';

const close: Array<() => void | Promise<void>> = [];
async function step<T>(name: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic X11 fixture stalled at ${name}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); });
class Channel extends Duplex {
  received: Buffer[] = [];
  _read() {}
  _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void) { this.received.push(Buffer.from(bytes)); this.emit('reply'); done(); }
  close() { this.destroy(); }
  send(bytes: Buffer) { this.push(bytes); }
}
function packet(cookie: string, little = true): Buffer {
  const header = Buffer.alloc(12), name = Buffer.alloc(20); Buffer.from('MIT-MAGIC-COOKIE-1').copy(name);
  header[0] = little ? 0x6c : 0x42;
  const word = (offset: number, value: number) => little ? header.writeUInt16LE(value, offset) : header.writeUInt16BE(value, offset);
  word(2, 11); word(6, 18); word(8, 16);
  return Buffer.concat([header, name, Buffer.from(cookie, 'hex')]);
}
const settings = { enabled: true, display: 0, screen: 0, cookie: 'manual' as const };
function setup() {
  const client = new EventEmitter(), connect = vi.fn<(display: number) => Socket>(() => { throw new Error('Must not contact a local display'); });
  const broker = new X11Forwarding(client as unknown as Client, connect);
  close.push(() => { client.emit('close'); });
  const channel = new Channel(), rejected = vi.fn();
  const incoming = () => client.emit('x11', { srcIP: 'untrusted-origin', srcPort: 6000 }, () => channel as unknown as ClientChannel, rejected);
  return { client, connect, broker, channel, rejected, incoming };
}
it('rejects channels without an active human-session binding', () => {
  const f = setup(); f.incoming(); expect(f.rejected).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled();
});
it.each(['wrong-cookie', 'invalid-header', 'revoked', 'disposed'] as const)('does not connect to the local desktop for %s', async (failure) => {
  const f = setup(), assertCurrent = vi.fn(), registration = f.broker.register(settings, Buffer.alloc(16, 1), assertCurrent);
  const data = packet(String(registration.request.cookie));
  if (failure === 'wrong-cookie') data[data.length - 1] = data.at(-1)! ^ 1;
  if (failure === 'invalid-header') data[0] = 0;
  if (failure === 'revoked') assertCurrent.mockImplementation(() => { throw new Error('revoked'); });
  if (failure === 'disposed') { registration.dispose(); f.incoming(); expect(f.rejected).toHaveBeenCalledOnce(); return; }
  f.incoming(); const ended = once(f.channel, 'close'); f.channel.send(data); await ended;
  expect(f.connect).not.toHaveBeenCalled(); expect(String(registration.request.cookie)).not.toBe('01'.repeat(16));
});
it('uses independent cookies per manual session and refuses excessive pending setup channels', () => {
  const f = setup(), first = f.broker.register(settings, Buffer.alloc(16, 1), () => {}), second = f.broker.register(settings, Buffer.alloc(16, 2), () => {});
  expect(first.request.cookie).not.toEqual(second.request.cookie);
  for (let i = 0; i < 16; i++) {
    const channel = new Channel(); f.client.emit('x11', {}, () => channel as unknown as ClientChannel, f.rejected);
  }
  f.incoming(); expect(f.rejected).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled();
});
it.each([true, false])('rewrites only the authenticated setup cookie and forwards bytes both ways (little endian: %s)', async (little) => {
  const f = setup(), sockets = new Set<Socket>(); let observed!: (bytes: Buffer) => void;
  const seen = new Promise<Buffer>((resolve) => { observed = resolve; });
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('data', (bytes) => { observed(Buffer.from(bytes)); socket.write('local-X-reply'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
  close.push(async () => { f.client.emit('close'); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  f.connect.mockImplementation(() => net.connect(address.port, '127.0.0.1'));
  const registration = f.broker.register(settings, Buffer.alloc(16, 0x42), () => {}); f.incoming();
  const response = once(f.channel, 'reply'), bytes = packet(String(registration.request.cookie), little);
  f.channel.send(bytes.subarray(0, 7)); f.channel.send(Buffer.concat([bytes.subarray(7), Buffer.from('extra-request')]));
  const local = await seen; await response;
  expect(local.subarray(32, 48)).toEqual(Buffer.alloc(16, 0x42)); expect(local.subarray(48).toString()).toBe('extra-request');
  expect(f.channel.received.map((part) => part.toString()).join('')).toBe('local-X-reply');
  expect(f.connect).toHaveBeenCalledExactlyOnceWith(0);
  const ended = once(f.channel, 'close'); registration.dispose(); await ended;
});
it('negotiates actual SSH X11 forwarding with a synthetic server, without an OS shell or personal Cookie', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const parsed = utils.parseKey(privateKey); if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
  const fingerprint = createHash('sha256').update(parsed.getPublicSSH()).digest('hex');
  const localSockets = new Set<Socket>(); let received!: (bytes: Buffer) => void;
  const localData = new Promise<Buffer>((resolve) => { received = resolve; });
  const localServer = net.createServer((socket) => { localSockets.add(socket); socket.on('error', () => {}); socket.once('data', (bytes) => { received(bytes); socket.write('X11-fixture-response'); }); });
  await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const localAddress = localServer.address(); if (!localAddress || typeof localAddress === 'string') throw new Error('Missing fixture port');
  let remote!: Connection, requested!: X11Info;
  const sshServer = new Server({ hostKeys: [privateKey] }, (connection) => {
    remote = connection; connection.on('error', () => {});
    connection.on('authentication', (auth) => auth.method === 'none' ? auth.accept() : auth.reject());
    connection.on('session', (accept) => {
      const session = accept();
      session.on('x11', (allow, _reject, info) => { requested = info; allow(); });
      session.on('exec', (allow, _reject, info) => { expect(info.command).toBe('fixture-no-shell'); allow().write('fixture'); });
    });
  });
  const client = new Client(); client.on('error', () => {});
  close.push(async () => {
    client.destroy(); remote?.end(); for (const socket of localSockets) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => localServer.close(() => resolve())), new Promise<void>((resolve) => sshServer.close(() => resolve()))]);
  });
  await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
  const address = sshServer.address(); if (!address || typeof address === 'string') throw new Error('Missing SSH port');
  const ready = once(client, 'ready');
  client.connect({ host: '127.0.0.1', port: address.port, username: 'fixture', authHandler: ['none'], hostVerifier: (key: Buffer) => createHash('sha256').update(key).digest('hex') === fingerprint });
  await step('ssh-ready', ready);
  const broker = new X11Forwarding(client, () => net.connect(localAddress.port, '127.0.0.1'));
  const registration = broker.register(settings, Buffer.alloc(16, 0x37), () => {});
  const shell = await step('exec-with-x11', new Promise<ClientChannel>((resolve, reject) => client.exec('fixture-no-shell', { x11: registration.request }, (error, channel) => error ? reject(error) : resolve(channel))));
  shell.once('close', registration.dispose); shell.resume();
  // ssh2 actually supplies the wire cookie as an ASCII Buffer, despite X11Info's string type.
  const wireCookie = String(requested.cookie);
  expect(wireCookie).toBe(registration.request.cookie); expect(wireCookie).not.toBe('37'.repeat(16));
  expect(wireCookie).toMatch(/^[a-f0-9]{32}$/u); expect(requested.protocol).toBe('MIT-MAGIC-COOKIE-1');
  const forwarding = await step('forward-channel', new Promise<ServerChannel>((resolve, reject) => remote.x11('untrusted-origin.invalid', 12345, (error, channel) => error ? reject(error) : resolve(channel))));
  const response = once(forwarding, 'data'); forwarding.write(packet(wireCookie));
  expect((await step('local-display-data', localData)).subarray(32, 48)).toEqual(Buffer.alloc(16, 0x37)); expect(String((await step('forward-response', response))[0])).toBe('X11-fixture-response');
  registration.dispose(); shell.close();
});
