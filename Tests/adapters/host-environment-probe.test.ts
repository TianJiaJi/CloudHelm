import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { HOST_ENVIRONMENT_PROBE, parseHostEnvironment, probeHostEnvironment } from '../../packages/adapters/src/host-environment-probe.js';

const metadata = { os: 'Linux', distribution: 'debian', version: '12', architecture: 'x86_64', kernel: '6.1',
  username: 'fixture', uid: 1000, directory: '/home/fixture', tools: { python3: true, docker: false } };
function channel() {
  const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn> };
  stream.stderr = new EventEmitter(); stream.close = vi.fn();
  return stream;
}
function fixture() {
  let callback!: (error: Error | undefined, stream: ClientChannel) => void;
  const exec = vi.fn((_command: string, cb: typeof callback) => { callback = cb; });
  const client = { exec } as unknown as Pick<Client, 'exec'>;
  return { client, exec, deliver: (stream: ReturnType<typeof channel>) => callback(undefined, stream as unknown as ClientChannel) };
}
afterEach(() => { vi.useRealTimers(); });
it('projects only bounded public fields, without arbitrary environment, cookies, tokens or error output', () => {
  const facts = parseHostEnvironment(JSON.stringify({ ...metadata, secret: 'private-password', environment: { API_KEY: 'secret-key' },
    tools: { ...metadata.tools, secretTool: true }, username: 'password=fixture-secret', kernel: 'bad\nvalue' }));
  expect(facts).toMatchObject({ os: 'Linux', uid: 1000, username: null, kernel: null, tools: metadata.tools });
  expect(JSON.stringify(facts)).not.toMatch(/private-password|secret-key|secretTool|fixture-secret/u);
  expect(parseHostEnvironment(JSON.stringify({ ...metadata, uid: -1, directory: 'relative' }))).toMatchObject({ uid: null, directory: null });
  expect(() => parseHostEnvironment('x'.repeat(16385))).toThrow('limit');
});
it('uses a fixed, isolated Python probe with no sudo, source or whole-environment access', () => {
  expect(HOST_ENVIRONMENT_PROBE).toMatch(/^python3 -I -S -B -c /u);
  expect(HOST_ENVIRONMENT_PROBE).not.toMatch(/sudo|\bsu\b|os\.environ|subprocess|source |XAUTHORITY|shadow/u);
  expect(HOST_ENVIRONMENT_PROBE).toContain('O_NOFOLLOW');
  expect(HOST_ENVIRONMENT_PROBE).toContain('O_NONBLOCK');
  expect(HOST_ENVIRONMENT_PROBE).toContain('stat.S_ISREG');
});
it('collects split UTF-8 only after a confirmed zero exit, ignoring stderr', async () => {
  const f = fixture(), stream = channel(), result = probeHostEnvironment(f.client);
  expect(f.exec.mock.calls[0]?.[0]).toBe(HOST_ENVIRONMENT_PROBE);
  f.deliver(stream);
  const bytes = Buffer.from(JSON.stringify({ ...metadata, directory: '/home/测试' }));
  for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
  stream.stderr.emit('data', Buffer.from('password=private-stderr'));
  stream.emit('exit', 0); stream.emit('close');
  expect(await result).toMatchObject({ ...metadata, directory: '/home/测试' });
});
it('starts the deadline before channel allocation and closes a late channel', async () => {
  vi.useFakeTimers();
  const f = fixture(), result = probeHostEnvironment(f.client);
  const failed = expect(result).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5000); await failed;
  const late = channel(); f.deliver(late);
  expect(late.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('cancels allocation without dispatching again, consumes late errors and closes late channels', async () => {
  vi.useFakeTimers();
  const f = fixture(), controller = new AbortController(), result = probeHostEnvironment(f.client, controller.signal);
  const failed = expect(result).rejects.toThrow('cancelled'); controller.abort(); await failed;
  const late = channel(); f.deliver(late); late.emit('error', new Error('late-private-detail'));
  expect(late.close).toHaveBeenCalledOnce(); expect(f.exec).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['stdout', 'stderr'])('bounds total %s bytes and never publishes truncated metadata as complete', async (kind) => {
  const f = fixture(), stream = channel(), result = probeHostEnvironment(f.client);
  const failed = expect(result).rejects.toThrow('limit'); f.deliver(stream);
  (kind === 'stdout' ? stream : stream.stderr).emit('data', Buffer.alloc(16385, 'x'));
  await failed; expect(stream.close).toHaveBeenCalledOnce();
});
it.each([undefined, 1])('requires a real zero exit, not merely a channel close (%s)', async (exit) => {
  const f = fixture(), stream = channel(), result = probeHostEnvironment(f.client);
  const failed = expect(result).rejects.toThrow('unavailable'); f.deliver(stream);
  stream.emit('data', Buffer.from(JSON.stringify(metadata)));
  if (exit !== undefined) stream.emit('exit', exit);
  stream.emit('close'); await failed;
});
it('never starts an already cancelled observation', () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect(() => probeHostEnvironment(f.client, controller.signal)).toThrow();
  expect(f.exec).not.toHaveBeenCalled();
});
