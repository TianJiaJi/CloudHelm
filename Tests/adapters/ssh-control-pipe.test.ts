import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { openSshControlPipe } from '../../packages/adapters/src/ssh-control-pipe.js';
afterEach(() => vi.useRealTimers());
function fixture() {
  let ready!: (error: Error | undefined, channel: ClientChannel) => void;
  const channel = Object.assign(new EventEmitter(), { end: vi.fn(), close: vi.fn() });
  const exec = vi.fn((_command: string, callback: typeof ready) => { ready = callback; });
  return { client: { exec } as unknown as Pick<Client, 'exec'>, exec, channel,
    deliver: () => ready(undefined, channel as unknown as ClientChannel) };
}
it('includes allocation in the deadline and discards late channels without retrying', async () => {
  vi.useFakeTimers(); const f = fixture();
  const pending = openSshControlPipe(f.client, 'fixed helper', () => true), failed = expect(pending).rejects.toThrow('15 秒');
  await vi.advanceTimersByTimeAsync(15000); await failed; f.deliver();
  expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.channel.end).toHaveBeenCalledOnce();
  expect(f.exec).toHaveBeenCalledOnce(); f.channel.emit('error', new Error('late'));
  expect(vi.getTimerCount()).toBe(0);
});
it('rechecks connection generation before accepting the allocated channel', async () => {
  vi.useFakeTimers(); const f = fixture(); let current = true;
  const pending = openSshControlPipe(f.client, 'fixed helper', () => current), failed = expect(pending).rejects.toThrow('代次');
  current = false; f.deliver(); await failed;
  expect(f.channel.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('clears the deadline on successful handoff without writing any payload', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = openSshControlPipe(f.client, 'fixed helper', () => true);
  f.deliver(); expect(await pending).toBe(f.channel);
  expect(f.channel.close).not.toHaveBeenCalled(); expect(f.channel.end).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
