import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { domainToASCII } from 'node:url';
import type { SshConnectionSettings } from '@cloudhelm/core';

type ProxySettings = NonNullable<SshConnectionSettings['proxy']>;
function destination(address: string): string {
  const plain = address.replace(/^\[|\]$/gu, '');
  if (net.isIP(plain)) return plain;
  const ascii = domainToASCII(plain);
  if (!ascii || ascii.length > 255 || !/^[a-zA-Z0-9._-]+$/u.test(ascii)) throw new Error('Invalid SSH destination');
  return ascii;
}

async function readable(socket: Socket, signal: AbortSignal, size?: number): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => { socket.off('readable', check); socket.off('error', failed); socket.off('end', ended); socket.off('close', ended); signal.removeEventListener('abort', aborted); };
    const failed = (error: Error) => { clean(); reject(error); };
    const ended = () => failed(new Error('Proxy connection closed during handshake'));
    const aborted = () => failed(new Error('Proxy connection timed out or cancelled'));
    const check = () => { const bytes = socket.read(size) as Buffer | null; if (bytes) { clean(); resolve(bytes); } else if (socket.destroyed || socket.readableEnded) ended(); };
    socket.on('readable', check); socket.once('error', failed); socket.once('end', ended); socket.once('close', ended);
    signal.addEventListener('abort', aborted, { once: true });
    check();
  });
}

async function connectProxy(proxy: ProxySettings, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  const address = destination(proxy.address);
  const socket = proxy.protocol === 'https' ? tls.connect({ host: address, port: proxy.port,
    servername: net.isIP(address) ? undefined : address, rejectUnauthorized: true }) : net.connect({ host: address, port: proxy.port });
  socket.on('error', () => {}); // Includes the hand-off between connection and protocol readers.
  return new Promise((resolve, reject) => {
    const readyEvent = proxy.protocol === 'https' ? 'secureConnect' : 'connect';
    const clean = () => { socket.off('error', failed); socket.off(readyEvent, ready); socket.off('close', closed); signal.removeEventListener('abort', abort); };
    const failed = (error: Error) => { clean(); socket.destroy(); reject(error); };
    const closed = () => failed(new Error('Proxy connection closed'));
    const abort = () => failed(new Error('Proxy connection timed out or cancelled'));
    const ready = () => { clean(); resolve(socket); };
    socket.once(readyEvent, ready); socket.once('error', failed); socket.once('close', closed);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

async function httpTunnel(socket: Socket, proxy: ProxySettings, host: string, port: number, password: string | undefined, signal: AbortSignal): Promise<void> {
  const authority = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  if (proxy.username?.includes(':')) throw new Error('HTTP proxy username cannot contain a colon');
  const authorization = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${password ?? ''}`, 'utf8').toString('base64')}\r\n` : '';
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);
  let header = Buffer.alloc(0);
  for (;;) {
    header = Buffer.concat([header, await readable(socket, signal)]);
    const end = header.indexOf('\r\n\r\n');
    if (end > 16_384 || end < 0 && header.length > 16_384) throw new Error('Proxy response header is too large');
    if (end < 0) continue;
    // Never include the proxy body or authentication headers in diagnostics.
    const match = /^HTTP\/1\.[01] (\d{3})[ \r]/u.exec(header.toString('latin1', 0, end + 2));
    if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) throw new Error(`Proxy CONNECT rejected (${match?.[1] ?? 'invalid status'})`);
    const remainder = header.subarray(end + 4); if (remainder.length) socket.unshift(remainder);
    return;
  }
}

function socksAddress(host: string): Buffer {
  if (net.isIP(host) === 4) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (net.isIP(host) === 6) {
    let expanded = host;
    if (host.includes('.')) {
      const boundary = host.lastIndexOf(':'); const parts = host.slice(boundary + 1).split('.').map(Number);
      expanded = `${host.slice(0, boundary)}:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
    }
    const halves = expanded.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
    const bytes = Buffer.alloc(17); bytes[0] = 4; words.forEach((word, index) => bytes.writeUInt16BE(parseInt(word, 16), index * 2 + 1)); return bytes;
  }
  const bytes = Buffer.from(host, 'ascii'); return Buffer.concat([Buffer.from([3, bytes.length]), bytes]);
}

async function socksTunnel(socket: Socket, proxy: ProxySettings, host: string, port: number, password: string | undefined, signal: AbortSignal): Promise<void> {
  // Configured credentials mean authentication is required: do not downgrade to anonymous.
  const method = proxy.username ? 2 : 0;
  socket.write(Buffer.from([5, 1, method]));
  const choice = await readable(socket, signal, 2);
  if (choice[0] !== 5 || choice[1] !== method) throw new Error('SOCKS proxy rejected the authentication method');
  if (method === 2) {
    const user = Buffer.from(proxy.username!, 'utf8'), pass = Buffer.from(password ?? '', 'utf8');
    if (!user.length || user.length > 255 || !pass.length || pass.length > 255) throw new Error('Invalid SOCKS proxy credentials');
    const packet = Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]);
    await new Promise<void>((resolve, reject) => socket.write(packet, (error) => { packet.fill(0); pass.fill(0); if (error) reject(error); else resolve(); }));
    const reply = await readable(socket, signal, 2);
    if (reply[0] !== 1 || reply[1] !== 0) throw new Error('SOCKS proxy authentication failed');
  }
  const targetPort = Buffer.alloc(2); targetPort.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), targetPort]));
  const reply = await readable(socket, signal, 4);
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS proxy CONNECT rejected');
  const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readable(socket, signal, 1))[0]! : 0;
  if (!length) throw new Error('SOCKS proxy returned an invalid address');
  await readable(socket, signal, length + 2);
}

/** Produces only a byte tunnel. SSH still verifies the destination host key.
 * On any proxy failure the socket is destroyed; direct connection is never retried. */
export async function openSshProxy(proxy: ProxySettings, address: string, port: number, password?: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<Socket> {
  const host = destination(address);
  if (!proxy.enabled || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy tunnel settings');
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const socket = await connectProxy(proxy, deadline);
  try {
    if (proxy.protocol === 'socks5') await socksTunnel(socket, proxy, host, port, password, deadline);
    else await httpTunnel(socket, proxy, host, port, password, deadline);
    deadline.throwIfAborted(); return socket;
  } catch (error) { socket.destroy(); throw error; }
}
