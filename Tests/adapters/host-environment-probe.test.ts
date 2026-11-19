import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { EXECUTION_PATH, HOST_ENVIRONMENT_SHELL_PROBE, HostEnvironmentProbeError, parseShellHostEnvironment, probeHostEnvironment } from '../../packages/adapters/src/host-environment-probe.js';

const facts = ['os=Linux', 'architecture=x86_64', 'kernel=6.1', 'username=fixture', 'uid=1000',
  'directory=/home/fixture', 'distribution=debian', 'version=12', 'tool.python3=1', 'tool.systemctl=0'].join('\n');
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
it('parses only the fixed shell vocabulary, dropping secrets, malformed lines and unknown keys', () => {
  const parsed = parseShellHostEnvironment([facts, 'secret=private-password', 'API_KEY=secret-key', 'tool.unknown=1',
    'username=password=fixture-secret', 'kernel=bad\u0001value', 'uid=not-a-number', 'directory=relative'].join('\n'));
  expect(parsed).toMatchObject({ os: 'Linux', distribution: 'debian', version: '12', architecture: 'x86_64',
    architectureFamily: 'x86_64', kernel: null, username: null, uid: null, loginDirectory: null,
    path: EXECUTION_PATH, toolPresence: { python3: true, systemctl: false }, source: 'shell' });
  expect(JSON.stringify(parsed)).not.toMatch(/private-password|secret-key|fixture-secret|unknown/u);
  expect(parseShellHostEnvironment('')).toMatchObject({ os: null, uid: null, toolPresence: {} });
  expect(() => parseShellHostEnvironment('x'.repeat(16385))).toThrow('limit');
});
it('resolves tool presence against the same fixed PATH that command execution uses', () => {
  expect(EXECUTION_PATH).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  // The PATH literal is single-quoted inside the POSIX-escaped `sh -c '...'` wrapper.
  expect(HOST_ENVIRONMENT_SHELL_PROBE).toContain(`PATH='\\''${EXECUTION_PATH}'\\''`);
  expect(HOST_ENVIRONMENT_SHELL_PROBE).toContain('command -v "$tool"');
});
it('uses a fixed, isolated POSIX shell probe with no runtime, elevation, sourcing or environment enumeration', () => {
  expect(HOST_ENVIRONMENT_SHELL_PROBE.startsWith("sh -c '")).toBe(true);
  expect(HOST_ENVIRONMENT_SHELL_PROBE.endsWith("'")).toBe(true);
  expect(HOST_ENVIRONMENT_SHELL_PROBE).not.toMatch(/sudo|\bsu\b|source |os\.environ|python3 -I|python3 -c|import |\.profile|\/etc\/shadow/u);
  expect(HOST_ENVIRONMENT_SHELL_PROBE).toContain('/etc/os-release');
  expect(HOST_ENVIRONMENT_SHELL_PROBE).toContain('/usr/lib/os-release');
});
(spawnSync('sh', ['-c', 'exit 0']).status === 0 ? it : it.skip)('runs the shell probe as an actual POSIX command', () => {
  const result = spawnSync('sh', ['-c', HOST_ENVIRONMENT_SHELL_PROBE], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('os=');
  expect(result.stdout).toContain('uid=');
  expect(result.stdout).toContain('tool.python3=');
});
it('collects split UTF-8 only after a confirmed zero exit, ignoring stderr', async () => {
  const f = fixture(), stream = channel(), result = probeHostEnvironment(f.client);
  expect(f.exec.mock.calls[0]?.[0]).toBe(HOST_ENVIRONMENT_SHELL_PROBE);
  f.deliver(stream);
  const text = facts.replace('directory=/home/fixture', 'directory=/home/测试');
  for (const byte of Buffer.from(text)) stream.emit('data', Buffer.from([byte]));
  stream.stderr.emit('data', Buffer.from('password=private-stderr'));
  stream.emit('exit', 0); stream.emit('close');
  const data = await result;
  expect(data).toMatchObject({ os: 'Linux', distribution: 'debian', version: '12', architecture: 'x86_64',
    architectureFamily: 'x86_64', kernel: '6.1', username: 'fixture', uid: 1000,
    loginDirectory: '/home/测试', path: EXECUTION_PATH, toolPresence: { python3: true, systemctl: false }, source: 'shell' });
  expect(JSON.stringify(data)).not.toContain('private-stderr');
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
  stream.emit('data', Buffer.from(facts));
  if (exit !== undefined) stream.emit('exit', exit);
  stream.emit('close'); await failed;
});
it('classifies a missing shell carrier as a permanent limitation, not a retry hint', async () => {
  const f = fixture(), stream = channel(), result = probeHostEnvironment(f.client);
  f.deliver(stream);
  stream.stderr.emit('data', Buffer.from('sh: not found'));
  stream.emit('exit', 127); stream.emit('close');
  const failure = await result.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HostEnvironmentProbeError);
  expect(failure).toMatchObject({ reason: 'unsupported' });
  expect((failure as Error).message).not.toContain('not found');
});
it('never starts an already cancelled observation', () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect(() => probeHostEnvironment(f.client, controller.signal)).toThrow();
  expect(f.exec).not.toHaveBeenCalled();
});
