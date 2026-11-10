import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareX11Forwarding } from '../../packages/adapters/src/x11-forwarding.js';
const fixture = vi.hoisted(() => ({ read: vi.fn<() => Promise<Buffer>>() }));
vi.mock('../../packages/adapters/src/x11-cookie.js', () => ({ localX11Cookie: fixture.read }));
afterEach(() => { fixture.read.mockReset(); vi.useRealTimers(); });
const settings = { enabled: true, display: 0, screen: 0, cookie: 'auto' as const };
function client() { return new EventEmitter() as unknown as Client; }
it('wipes the loaded secret after installing a fake-cookie binding', async () => {
  vi.useFakeTimers(); const bytes = Buffer.alloc(16, 0x41), ssh = client(); fixture.read.mockResolvedValue(bytes);
  const binding = await prepareX11Forwarding(ssh, settings, () => {});
  expect(bytes).toEqual(Buffer.alloc(16)); expect(binding.request.cookie).not.toBe('41'.repeat(16));
  expect(vi.getTimerCount()).toBe(0); binding.dispose(); ssh.emit('close');
});
it.each(['cancel', 'deadline'] as const)('wipes a late cookie and never enables forwarding after %s', async (cause) => {
  vi.useFakeTimers(); let loaded!: (bytes: Buffer) => void;
  fixture.read.mockReturnValue(new Promise<Buffer>((resolve) => { loaded = resolve; }));
  const ssh = client(), controller = new AbortController();
  const preparing = prepareX11Forwarding(ssh, settings, () => {}, undefined, controller.signal);
  const rejected = expect(preparing).rejects.toThrow(cause === 'cancel' ? '取消' : '超时');
  if (cause === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(10000);
  await rejected; const bytes = Buffer.alloc(16, 0x42); loaded(bytes); await Promise.resolve();
  expect(bytes).toEqual(Buffer.alloc(16)); expect(ssh.listenerCount('x11')).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('does not read any credential after prior cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(prepareX11Forwarding(client(), settings, () => {}, undefined, controller.signal)).rejects.toThrow();
  expect(fixture.read).not.toHaveBeenCalled();
});
