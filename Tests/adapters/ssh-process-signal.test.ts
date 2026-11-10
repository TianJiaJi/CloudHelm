import { afterEach, expect, it, vi } from 'vitest';
import { ProcessInterrupt } from '../../packages/adapters/src/ssh-process-signal.js';
afterEach(() => vi.useRealTimers());

it('binds one signal attempt to the process and nonce, not an output string or exit', async () => {
  const send = vi.fn(), signal = new ProcessInterrupt(42, () => {}, send), reply = signal.interrupt(42);
  const message = send.mock.calls[0]![0];
  expect(message).toMatchObject({ type: 'signal', signal: 'SIGINT', pid: 42 });
  expect(message.id).toMatch(/^[a-f0-9]{32}$/u);
  expect(signal.receive({ type: 'data', data: 'signal sent' })).toBe(false);
  expect(signal.receive({ type: 'signal-result', id: 'wrong', pid: 42, status: 'sent' })).toBe(false);
  expect(signal.receive({ type: 'signal-result', id: message.id, pid: 43, status: 'sent' })).toBe(false);
  expect(signal.receive({ type: 'signal-result', id: message.id, pid: 42, status: 'sent' })).toBe(true);
  expect(await reply).toBe('sent'); expect(await signal.interrupt(42)).toBe('sent');
  expect(send).toHaveBeenCalledOnce(); signal.close();
});

it('refuses stale process and expired authority before any send', async () => {
  const send = vi.fn(), signal = new ProcessInterrupt(42, () => { throw new Error('expired'); }, send);
  await expect(signal.interrupt(43)).rejects.toThrow('绑定');
  await expect(signal.interrupt(42)).rejects.toThrow('权限');
  expect(send).not.toHaveBeenCalled(); signal.close();
});

it('bounds acknowledgement wait and never retries after timeout, even if a late acknowledgement arrives', async () => {
  vi.useFakeTimers(); const send = vi.fn(), signal = new ProcessInterrupt(42, () => {}, send);
  const pending = signal.interrupt(42), failed = expect(pending).rejects.toThrow('未获得确认');
  await vi.advanceTimersByTimeAsync(5000); await failed;
  const request = send.mock.calls[0]![0];
  expect(signal.receive({ type: 'signal-result', id: request.id, pid: 42, status: 'sent' })).toBe(true);
  await expect(signal.interrupt(42)).rejects.toThrow('未获得确认');
  expect(send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); signal.close();
});

it('does not equate channel close with an acknowledged stop or process exit', async () => {
  vi.useFakeTimers(); const signal = new ProcessInterrupt(42, () => {}, vi.fn());
  const pending = signal.interrupt(42), failed = expect(pending).rejects.toThrow('不代表进程已退出');
  signal.close(); await failed;
  expect(vi.getTimerCount()).toBe(0); await expect(signal.interrupt(42)).rejects.toThrow('绑定');
});
