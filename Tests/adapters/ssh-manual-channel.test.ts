import { afterEach, expect, it, vi } from 'vitest';
import type { Client, ClientChannel, ExecOptions } from 'ssh2';
import { openManualChannel } from '../../packages/adapters/src/ssh-manual-channel.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  let reply!: (error: Error | undefined, channel: ClientChannel) => void;
  const exec = vi.fn((_command: string, _options: ExecOptions, callback: typeof reply) => { reply = callback; });
  const client = { exec } as unknown as Client;
  const channel = { close: vi.fn() } as unknown as ClientChannel;
  return { client, channel, exec, reply: (error?: Error) => reply(error, channel) };
}
it('does not dispatch a revoked or already cancelled manual startup', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect(() => openManualChannel(f.client, 'fixture', {}, () => {}, controller.signal)).toThrow();
  await expect(openManualChannel(f.client, 'fixture', {}, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(f.exec).not.toHaveBeenCalled();
});
it('bounds startup and closes a late channel without replay or a false not-started claim', async () => {
  vi.useFakeTimers(); const f = fixture();
  const result = openManualChannel(f.client, 'fixture', {}, () => {});
  const rejected = expect(result).rejects.toThrow('结果未确认');
  await vi.advanceTimersByTimeAsync(30000); await rejected;
  f.reply(); expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.exec).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending startup immediately and never adopts its late channel', async () => {
  vi.useFakeTimers(); const f = fixture(), controller = new AbortController();
  const result = openManualChannel(f.client, 'fixture', {}, () => {}, controller.signal);
  const rejected = expect(result).rejects.toThrow('远端可能已经收到请求'); controller.abort(); await rejected;
  f.reply(); expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.exec).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('settles successful startup exactly once and removes the startup deadline', async () => {
  vi.useFakeTimers(); const f = fixture(), controller = new AbortController();
  const result = openManualChannel(f.client, 'fixture', { pty: true }, () => {}, controller.signal);
  f.reply(); expect(await result).toBe(f.channel); expect(vi.getTimerCount()).toBe(0);
  controller.abort(); expect(f.channel.close).not.toHaveBeenCalled(); // Shell owner manages post-startup revocation.
});
it('returns channel refusal without retry and clears its timer', async () => {
  vi.useFakeTimers(); const f = fixture(); const result = openManualChannel(f.client, 'fixture', {}, () => {});
  const rejected = expect(result).rejects.toThrow('channel refused'); f.reply(new Error('channel refused')); await rejected;
  expect(f.exec).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
