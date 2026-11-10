import { EventEmitter } from 'node:events';
import type { Server } from 'node:net';
import { expect, it } from 'vitest';
import { isFetchPortAllowed, listenForFetch } from './fetch-listener.js';
import { openAiFixture } from './pi-session-fixture.js';

class Listener extends EventEmitter {
  bindings = 0; releases = 0; bound = false;
  constructor(private readonly ports: number[], private readonly bindError?: Error) { super(); }
  listen(port: number, host: string, ready: () => void): this {
    expect(port).toBe(0); expect(host).toBe('127.0.0.1');
    expect(this.bound).toBe(false); this.bindings++;
    queueMicrotask(() => {
      if (this.bindError) this.emit('error', this.bindError);
      else { this.bound = true; ready(); }
    });
    return this;
  }
  address() { return { port: this.ports[Math.min(this.bindings - 1, this.ports.length - 1)], family: 'IPv4', address: '127.0.0.1' }; }
  close(done: () => void): this { this.bound = false; this.releases++; queueMicrotask(done); return this; }
}
it.each([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])(
  'rejects Fetch-forbidden port %s within the observed dynamic range', (port) => {
    expect(isFetchPortAllowed(port)).toBe(false);
  });
it('releases forbidden allocations before exposing any endpoint or dispatching a request', async () => {
  const server = new Listener([6000, 10080, 12000]);
  expect(await listenForFetch(server as unknown as Server)).toBe(12000);
  expect(server.bindings).toBe(3); expect(server.releases).toBe(2); expect(server.bound).toBe(true);
  expect(server.listenerCount('error')).toBe(0);
});
it('does not rebind an already compatible listener', async () => {
  const server = new Listener([15000]);
  expect(await listenForFetch(server as unknown as Server)).toBe(15000);
  expect(server.bindings).toBe(1); expect(server.releases).toBe(0);
});
it('does not retry real bind errors', async () => {
  const error = new Error('synthetic EADDRINUSE'), server = new Listener([], error);
  await expect(listenForFetch(server as unknown as Server)).rejects.toBe(error);
  expect(server.bindings).toBe(1); expect(server.releases).toBe(0);
});
it('bounds allocation and closes every unusable listener', async () => {
  const server = new Listener([10080]);
  await expect(listenForFetch(server as unknown as Server)).rejects.toThrow('Fetch-compatible');
  expect(server.bindings).toBe(16); expect(server.releases).toBe(16); expect(server.bound).toBe(false);
});
it('exposes a usable SSE fixture without making or replaying a model request during allocation', async () => {
  const fixture = await openAiFixture(async () => ({ text: 'synthetic-result' }));
  try {
    expect(isFetchPortAllowed(Number(new URL(fixture.baseUrl).port))).toBe(true);
    expect(fixture.connections).toBe(0); expect(fixture.requests).toEqual([]);
    const response = await fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', stream: true, messages: [] }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain('synthetic-result');
    expect(fixture.requests).toHaveLength(1); expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
it.each([0, -1, 65536, 1.5, NaN])('does not advertise invalid port %s', (port) => {
  expect(isFetchPortAllowed(port)).toBe(false);
});
