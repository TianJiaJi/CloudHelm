import { afterEach, expect, it, vi } from 'vitest';
import type { Client, SFTPWrapper } from 'ssh2';
import { EventEmitter } from 'node:events';
import { withSftpSession } from '../../packages/adapters/src/ssh-sftp-session.js';

function fixture() {
  const end = vi.fn();
  const channel = Object.assign(new EventEmitter(), { end }) as unknown as SFTPWrapper;
  const open = vi.fn((callback: (error: undefined, channel: SFTPWrapper) => void) => callback(undefined, channel));
  return { end, channel, open, client: { sftp: open } as unknown as Pick<Client, 'sftp'> };
}
afterEach(() => vi.useRealTimers());

it('closes only the owned SFTP channel after successful work', async () => {
  const f = fixture();
  expect(await withSftpSession(f.client, async (channel, guard) => {
    guard(); expect(channel).toBe(f.channel); return 'done';
  })).toBe('done');
  expect(f.end).toHaveBeenCalledOnce();
});

it('does not open a channel for an already canceled action', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(withSftpSession(f.client, async () => 'unused', { signal: controller.signal })).rejects.toThrow();
  expect(f.open).not.toHaveBeenCalled();
});

it('includes channel opening in the deadline and closes a late channel', async () => {
  vi.useFakeTimers();
  const f = fixture(), action = vi.fn();
  let respond!: (error: undefined, channel: SFTPWrapper) => void;
  f.open.mockImplementation((callback) => { respond = callback; });
  const rejection = expect(withSftpSession(f.client, action, { timeoutMs: 30 })).rejects.toThrow('deadline exceeded');
  await vi.advanceTimersByTimeAsync(31); await rejection;
  respond(undefined, f.channel); await Promise.resolve();
  expect(f.end).toHaveBeenCalledOnce(); expect(action).not.toHaveBeenCalled();
});

it.each(['timeout', 'cancel'] as const)('revokes late action continuations after %s', async (reason) => {
  vi.useFakeTimers();
  const f = fixture(), controller = new AbortController(), mutate = vi.fn();
  let resume!: () => void;
  const action = withSftpSession(f.client, async (_channel, guard) => {
    await new Promise<void>((resolve) => { resume = resolve; });
    guard(); mutate(); return 'late';
  }, { timeoutMs: 30, signal: controller.signal });
  const rejection = expect(action).rejects.toThrow(reason === 'cancel' ? 'canceled' : 'deadline exceeded');
  await Promise.resolve(); await Promise.resolve();
  if (reason === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(31);
  await rejection;
  resume(); await Promise.resolve(); await Promise.resolve();
  expect(mutate).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledOnce();
  expect(() => f.channel.emit('error', new Error('late fixture error'))).not.toThrow();
});

it.each(['error', 'close'] as const)('rejects promptly when the owned channel emits %s', async (event) => {
  const f = fixture();
  const result = expect(withSftpSession(f.client, () => new Promise(() => {}))).rejects.toThrow(/fixture|closed/u);
  f.channel.emit(event, new Error('fixture channel error'));
  await result;
  expect(f.end).toHaveBeenCalledOnce();
});

it('rejects a changed SSH connection before any new I/O boundary', async () => {
  const f = fixture(); let current = true;
  await expect(withSftpSession(f.client, async (_channel, guard) => {
    guard(); current = false; guard(); return 'unreachable';
  }, { isCurrent: () => current })).rejects.toThrow('connection changed');
  expect(f.end).toHaveBeenCalledOnce();
});
