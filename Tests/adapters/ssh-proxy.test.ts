import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { tlsProxyFixture } from './tls-proxy-fixture.js';
import net, { type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection } from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HostKeyError, SshTransport, type SshHost } from '../../packages/adapters/src/ssh-transport.js';

// Loopback protocol fixtures only. No real proxies, user keys, OS login or shell.
let ssh: Server, host: SshHost;
let targetConnections = 0, methods: string[] = [], requests: string[] = [], proxyFailure = false, requireProxyAuth = false;
const sockets = new Set<Socket>(), connections = new Set<Connection>(), transports: SshTransport[] = [];
const defaultCAs = tls.getCACertificates('default');
const proxies: Array<http.Server | net.Server> = [], fixtureErrors: unknown[] = [];
function track(socket: Socket): Socket { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; }
async function listen(server: http.Server | net.Server): Promise<number> {
  proxies.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address'); return address.port;
}
async function take(socket: Socket, count: number): Promise<Buffer> {
  for (;;) { const bytes = socket.read(count) as Buffer | null; if (bytes) return bytes; await once(socket, 'readable'); }
}
beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const key = utils.parseKey(privateKey); if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid fixture key');
  ssh = new Server({ hostKeys: [privateKey] }, (client) => {
    targetConnections++; connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', (context) => {
      methods.push(context.method);
      if (context.method === 'password' && context.password === 'login-password') context.accept();
      else context.reject(['publickey', 'password']);
    });
    client.on('session', (_accept, reject) => { fixtureErrors.push(new Error('Connection testing must not open a session')); reject(); });
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  const address = ssh.address(); if (!address || typeof address === 'string') throw new Error('Missing SSH fixture address');
  host = { id: 'fixture', label: 'Fixture', address: '127.0.0.1', port: address.port, username: 'fixture', auth: 'password',
    fingerprint: `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/u, '')}` };
});
beforeEach(() => { targetConnections = 0; methods = []; requests = []; proxyFailure = false; requireProxyAuth = false; });
afterEach(async () => {
  tls.setDefaultCACertificates(defaultCAs);
  for (const transport of transports.splice(0)) transport.close();
  for (const socket of sockets) socket.destroy();
  for (const connection of connections) connection.end();
  await Promise.all(proxies.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  expect(fixtureErrors.splice(0)).toEqual([]);
});
afterAll(async () => { await new Promise<void>((resolve) => ssh.close(() => resolve())); });
async function httpProxy(identity?: { cert: string; key: string }) {
  const server = identity ? https.createServer(identity) : http.createServer(); server.on('connection', (socket) => track(socket));
  server.on('connect', (request, socket) => {
    requests.push(request.url ?? '');
    if (proxyFailure) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
    if (requireProxyAuth && request.headers['proxy-authorization'] !== `Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`) {
      fixtureErrors.push(new Error('Incorrect proxy credentials')); socket.destroy(); return;
    }
    const upstream = track(net.connect({ host: host.address, port: host.port }));
    // Split response and preserve any SSH identification arriving immediately afterwards.
    socket.write('HTTP/1.1 200 Connection Established\r\n');
    setImmediate(() => { socket.write('\r\n'); socket.pipe(upstream).pipe(socket); });
  });
  return listen(server);
}
async function socksProxy() {
  return listen(net.createServer((socket) => {
    track(socket);
    void (async () => {
      expect(await take(socket, 3)).toEqual(Buffer.from([5, 1, requireProxyAuth ? 2 : 0]));
      socket.write(Buffer.from([5])); socket.write(Buffer.from([proxyFailure ? 255 : requireProxyAuth ? 2 : 0]));
      if (proxyFailure) return;
      if (requireProxyAuth) {
        const auth = await take(socket, 2); expect(auth[0]).toBe(1);
        expect((await take(socket, auth[1]!)).toString()).toBe('proxy-user');
        const length = (await take(socket, 1))[0]!; expect((await take(socket, length)).toString()).toBe('proxy-password');
        socket.write(Buffer.from([1, 0]));
      }
      const command = await take(socket, 4); expect(command.subarray(0, 3)).toEqual(Buffer.from([5, 1, 0]));
      const address = command[3] === 1 ? [...await take(socket, 4)].join('.')
        : command[3] === 3 ? (await take(socket, (await take(socket, 1))[0]!)).toString('ascii')
          : (await take(socket, 16)).toString('hex');
      const port = (await take(socket, 2)).readUInt16BE(); requests.push(`${address}:${port}`);
      const upstream = track(net.connect({ host: host.address, port: host.port }));
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22])); socket.pipe(upstream).pipe(socket);
    })().catch((error: unknown) => { fixtureErrors.push(error); socket.destroy(); });
  }));
}
function connect(target: SshHost, proxyPassword?: string) {
  const transport = new SshTransport(); transports.push(transport);
  return { transport, result: transport.connect(target, { password: 'login-password', proxyPassword }, undefined, undefined, undefined, { onDemandAuthentication: true }) };
}
it.each(['http', 'socks5'] as const)('authenticates SSH through a real %s tunnel without running commands', async (protocol) => {
  const port = await (protocol === 'http' ? httpProxy() : socksProxy()); requireProxyAuth = true;
  const target: SshHost = { ...host, connection: { version: 1, proxy: { enabled: true, protocol, address: '127.0.0.1', port, username: 'proxy-user' } } };
  const f = connect(target, 'proxy-password'); await f.result;
  expect(f.transport.isConnected(host.id)).toBe(true); expect(methods).toEqual(['none', 'password']);
  expect(requests).toEqual([`${host.address}:${host.port}`]); expect(targetConnections).toBe(1);
});
it('authenticates through HTTPS CONNECT with certificate verification enabled', async () => {
  const identity = tlsProxyFixture(); tls.setDefaultCACertificates([...defaultCAs, identity.cert]);
  const port = await httpProxy(identity); requireProxyAuth = true;
  const f = connect({ ...host, connection: { version: 1, proxy: { enabled: true, protocol: 'https', address: '127.0.0.1', port, username: 'proxy-user' } } }, 'proxy-password');
  await f.result;
  expect(methods).toEqual(['none', 'password']); expect(requests).toEqual([`${host.address}:${host.port}`]); expect(targetConnections).toBe(1);
});
it.each(['untrusted', 'wrong-identity'] as const)('rejects an HTTPS proxy certificate that is %s before sending credentials', async (failure) => {
  const identity = tlsProxyFixture(failure === 'wrong-identity' ? 2 : 1);
  if (failure === 'wrong-identity') tls.setDefaultCACertificates([...defaultCAs, identity.cert]);
  const port = await httpProxy(identity);
  const f = connect({ ...host, connection: { version: 1, proxy: { enabled: true, protocol: 'https', address: '127.0.0.1', port, username: 'proxy-user' } } }, 'proxy-password');
  await expect(f.result).rejects.toThrow(/certificate|IP|altnames/iu);
  expect(requests).toEqual([]); expect(methods).toEqual([]); expect(targetConnections).toBe(0);
});
it.each(['http', 'socks5'] as const)('does not fall back to direct SSH after %s proxy refusal', async (protocol) => {
  const port = await (protocol === 'http' ? httpProxy() : socksProxy()); proxyFailure = true;
  const f = connect({ ...host, connection: { version: 1, proxy: { enabled: true, protocol, address: '127.0.0.1', port } } });
  await expect(f.result).rejects.toThrow(/proxy/iu); expect(f.transport.isConnected(host.id)).toBe(false);
  expect(targetConnections).toBe(0); expect(methods).toEqual([]);
});
it('retains end-host fingerprint verification through an authenticated proxy', async () => {
  const port = await httpProxy(); requireProxyAuth = true;
  const f = connect({ ...host, fingerprint: 'SHA256:wrong', connection: { version: 1,
    proxy: { enabled: true, protocol: 'http', address: '127.0.0.1', port, username: 'proxy-user' } } }, 'proxy-password');
  await expect(f.result).rejects.toBeInstanceOf(HostKeyError); expect(methods).toEqual([]);
});
it('does not contact a disabled proxy', async () => {
  const port = await httpProxy(); proxyFailure = true;
  await connect({ ...host, connection: { version: 1, proxy: { enabled: false, protocol: 'http', address: '127.0.0.1', port } } }).result;
  expect(requests).toEqual([]); expect(targetConnections).toBe(1);
});
it('sends DNS destinations to SOCKS instead of resolving them locally', async () => {
  const port = await socksProxy();
  await connect({ ...host, address: 'fixture.invalid', connection: { version: 1, proxy: { enabled: true, protocol: 'socks5', address: '127.0.0.1', port } } }).result;
  expect(requests).toEqual([`fixture.invalid:${host.port}`]);
});
it('uses a configured proxy instead of contacting the single jump host', async () => {
  const port = await httpProxy(), transport = new SshTransport(); transports.push(transport);
  await transport.connect({ ...host, connection: { version: 1, proxy: { enabled: true, protocol: 'http', address: '127.0.0.1', port } } },
    { password: 'login-password' }, { host: { ...host, id: 'jump', auth: 'agent' }, secret: {} }, undefined, undefined, { onDemandAuthentication: true });
  expect(transport.isConnected('jump')).toBe(false); expect(targetConnections).toBe(1);
});
it('honors explicit password-first authentication without opening an unneeded key file', async () => {
  await connect({ ...host, auth: 'private-key', privateKeyPath: '/nonexistent-synthetic-key', connection: { version: 1, authOrder: ['password', 'private-key'] } }).result;
  expect(methods).toEqual(['none', 'password']);
});
it('honors key-first authentication and does not silently ignore a broken configured key', async () => {
  await expect(connect({ ...host, auth: 'private-key', privateKeyPath: '/nonexistent-synthetic-key', connection: { version: 1, authOrder: ['private-key', 'password'] } }).result)
    .rejects.toMatchObject({ code: 'authentication-unconfirmed' });
  expect(methods).toEqual(['none']);
});
it('does not downgrade incompatible explicitly configured algorithms', async () => {
  const challenge = vi.fn(async () => 'must-not-be-requested'), transport = new SshTransport(); transports.push(transport);
  await expect(transport.connect({ ...host, connection: { version: 1, algorithms: { hostKey: ['ssh-ed25519'] } } }, {}, undefined, challenge, undefined,
    { onDemandAuthentication: true })).rejects.toThrow();
  expect(challenge).not.toHaveBeenCalled(); expect(methods).toEqual([]);
});
