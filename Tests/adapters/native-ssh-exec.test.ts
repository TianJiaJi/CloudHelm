import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { expect, it, vi } from 'vitest';
import { runNativeSshExec } from '../../packages/adapters/src/native-ssh-exec.js';

const request = { command: 'id -u', cwd: '/', envPath: '/usr/bin/env', shellPath: '/bin/sh' };
class Channel extends EventEmitter {
  stderr = new EventEmitter();
  close = vi.fn(() => this.emit('close'));
}
function fixture() {
  const channel = new Channel();
  const exec = vi.fn((_command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
    queueMicrotask(() => callback(undefined, channel as unknown as ClientChannel));
  });
  const stdout = vi.fn(), stderr = vi.fn();
  const client = { exec } as unknown as Pick<Client, 'exec'>;
  return { channel, exec, stdout, stderr, client,
    run: (signal?: AbortSignal, current = () => true) => runNativeSshExec(client, request, current, { stdout, stderr }, signal) };
}

it('dispatches one non-PTY exec with a sanitized child environment and preserves stderr bytes', async () => {
  const f = fixture(), result = f.run();
  await vi.waitFor(() => expect(f.channel.listenerCount('exit')).toBe(1));
  const [command, options] = f.exec.mock.calls[0]!;
  expect(command).toContain('env -i PATH='); expect(command).not.toContain('python');
  expect(options).toEqual({ pty: false });
  f.channel.emit('data', Buffer.from([0, 255]));
  f.channel.stderr.emit('data', Buffer.from([1, 2]));
  f.channel.emit('exit', 0);
  f.channel.emit('close');
  expect(await result).toEqual({ state: 'exited', exitCode: 0 });
  expect(f.stdout.mock.calls[0]![0]).toEqual(Buffer.from([0, 255]));
  expect(f.stderr.mock.calls[0]![0]).toEqual(Buffer.from([1, 2]));
});

it('does not equate a closed channel or an allocation failure with process exit', async () => {
  const f = fixture(), result = f.run();
  await vi.waitFor(() => expect(f.channel.listenerCount('close')).toBe(1));
  f.channel.emit('close');
  expect(await result).toEqual({ state: 'unknown', reason: 'missing-exit' });
  const callback = f.exec.mock.calls[0]![2];
  expect(callback).toBeTypeOf('function');
});

it('records explicit remote signal separately from exit code', async () => {
  const f = fixture(), result = f.run();
  await vi.waitFor(() => expect(f.channel.listenerCount('exit')).toBe(1));
  f.channel.emit('exit', null, 'TERM', false);
  f.channel.emit('close');
  expect(await result).toEqual({ state: 'signaled', signal: 'TERM', coreDumped: false });
});

it('fails closed before dispatch and reports unknown after aborting a dispatched request', async () => {
  const f = fixture();
  expect(await f.run(undefined, () => false)).toEqual({ state: 'not-dispatched', reason: 'authorization-expired' });
  expect(f.exec).not.toHaveBeenCalled();
  const controller = new AbortController(), result = f.run(controller.signal);
  await vi.waitFor(() => expect(f.channel.listenerCount('exit')).toBe(1));
  controller.abort();
  expect(await result).toEqual({ state: 'unknown', reason: 'aborted' });
  expect(f.channel.close).toHaveBeenCalled();
});

it('does not interpret allocation errors as not dispatched and refuses late sessions', async () => {
  const f = fixture();
  const result = f.run();
  f.exec.mock.calls[0]![2](new Error('rejected'), undefined as unknown as ClientChannel);
  expect(await result).toEqual({ state: 'unknown', reason: 'allocation' });
  await Promise.resolve();
  expect(f.channel.close).toHaveBeenCalled();
});

it('treats an authorization change before observed close as unknown', async () => {
  const f = fixture(); let current = true;
  const result = f.run(undefined, () => current);
  await vi.waitFor(() => expect(f.channel.listenerCount('close')).toBe(1));
  f.channel.emit('exit', 0);
  current = false;
  f.channel.emit('close');
  expect(await result).toEqual({ state: 'unknown', reason: 'authorization-expired' });
});

it('does not deliver output after authorization is revoked', async () => {
  const f = fixture(); let current = true;
  const result = f.run(undefined, () => current);
  await vi.waitFor(() => expect(f.channel.listenerCount('data')).toBe(1));
  current = false;
  f.channel.emit('data', Buffer.from('possibly private output'));
  expect(await result).toEqual({ state: 'unknown', reason: 'authorization-expired' });
  expect(f.stdout).not.toHaveBeenCalled();
});

it('caps combined raw stdout and stderr and reports an unknown effect when exceeded', async () => {
  const f = fixture(), result = f.run();
  await vi.waitFor(() => expect(f.channel.listenerCount('data')).toBe(1));
  f.channel.emit('data', Buffer.alloc(1_048_576));
  f.channel.stderr.emit('data', Buffer.from([1]));
  expect(await result).toEqual({ state: 'unknown', reason: 'output-limit' });
  expect(f.stdout).toHaveBeenCalledOnce();
  expect(f.stderr).not.toHaveBeenCalled();
});

it('treats an unacknowledged exec allocation timeout as possibly dispatched', async () => {
  vi.useFakeTimers();
  try {
    const exec = vi.fn();
    const result = runNativeSshExec({ exec } as unknown as Pick<Client, 'exec'>, request, () => true,
      { stdout: vi.fn(), stderr: vi.fn() }, undefined, 25);
    await vi.advanceTimersByTimeAsync(26);
    expect(exec).toHaveBeenCalledOnce();
    expect(await result).toEqual({ state: 'unknown', reason: 'timeout' });
  } finally { vi.useRealTimers(); }
});
