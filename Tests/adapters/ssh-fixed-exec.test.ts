import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { runFixedSshCommand } from '../../packages/adapters/src/ssh-fixed-exec.js';
function fixture() {
  let ready!: (error: Error | undefined, channel: ClientChannel) => void;
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn() });
  const exec = vi.fn((_command: string, callback: typeof ready) => { ready = callback; });
  return { channel, exec, client: { exec } as unknown as Pick<Client, 'exec'>,
    deliver: () => ready(undefined, channel as unknown as ClientChannel) };
}
afterEach(() => vi.useRealTimers());
it('counts channel allocation in the fixed deadline and closes late results without dispatch retry', async () => {
  vi.useFakeTimers(); const f = fixture();
  const pending = runFixedSshCommand(f.client, 'pwd -P', () => true);
  const failed = expect(pending).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(15000); await failed;
  f.deliver(); f.channel.emit('error', new Error('late'));
  expect(f.channel.close).toHaveBeenCalledOnce(); expect(f.exec).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('rejects stale identity before dispatch and again before accepting a result', async () => {
  const f = fixture();
  await expect(runFixedSshCommand(f.client, 'pwd -P', () => false)).rejects.toThrow('代次');
  expect(f.exec).not.toHaveBeenCalled();
  let current = true;
  const pending = runFixedSshCommand(f.client, 'pwd -P', () => current), failed = expect(pending).rejects.toThrow('代次');
  f.deliver(); f.channel.emit('data', Buffer.from('/old/home')); f.channel.emit('exit', 0);
  current = false; f.channel.emit('close'); await failed;
});
it('keeps UTF-8 bytewise output intact and preserves the fixed tail bound', async () => {
  const f = fixture(), pending = runFixedSshCommand(f.client, 'pwd -P', () => true); f.deliver();
  const value = '🙂'.repeat(3000) + '/home/测试\\n';
  for (const byte of Buffer.from(value)) f.channel.emit('data', Buffer.from([byte]));
  f.channel.emit('exit', 0); f.channel.emit('close');
  const result = await pending;
  expect(result.exitCode).toBe(0); expect(result.output).toContain('/home/测试\\n'); expect(result.output.length).toBeLessThanOrEqual(4096);
  expect(Buffer.from(result.output).toString('utf8')).toBe(result.output);
});
it('does not infer zero exit from a channel close and clears the timeout on transport failure', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = runFixedSshCommand(f.client, 'pwd -P', () => true); f.deliver();
  f.channel.emit('close'); expect(await pending).toEqual({ exitCode: -1, output: '' }); expect(vi.getTimerCount()).toBe(0);
  const next = fixture(), failed = runFixedSshCommand(next.client, 'pwd -P', () => true);
  const rejected = expect(failed).rejects.toThrow('broken'); next.deliver(); next.channel.emit('error', new Error('broken'));
  await rejected; expect(vi.getTimerCount()).toBe(0);
});
