import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationInput, ConversationSession, QueuedSessionInput } from '@cloudhelm/core';
import { TaskInputQueue } from '../../../apps/desktop/src/worker/task-input-queue.js';
const queues: TaskInputQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.dispose(); });
const input = { id: 'input', kind: 'followUp' as const, text: 'next task', intent: 'next task' };
function fixture(commit: (value: ConversationInput) => Promise<void> = async () => {}) {
  const native = { isStreaming: true, queueInput: vi.fn(), cancelQueuedInput: vi.fn(() => true) };
  const activate = vi.fn(), failed = vi.fn(), publish = vi.fn(); let authorization = 'scope-1';
  const queue = new TaskInputQueue('task', [], { session: () => native as unknown as ConversationSession,
    authorizationKey: () => authorization, assertActive() {}, publish, commit, activate, failed });
  queues.push(queue);
  return { queue, native, activate, failed, publish, changeAuthorization: () => { authorization = 'scope-2'; } };
}
it('does not overwrite current intent at enqueue and waits for selected-input persistence', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(async (value) => { if (value.status === 'delivering') await hold; });
  await f.queue.enqueue(input); expect(f.activate).not.toHaveBeenCalled();
  const selected = f.queue.selected(f.native.queueInput.mock.calls[0]![0] as QueuedSessionInput);
  await Promise.resolve(); expect(f.activate).not.toHaveBeenCalled();
  release(); await selected;
  expect(f.activate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'input', status: 'delivering' }));
  await f.queue.delivered('input', 'native-entry');
  expect(f.queue.snapshot()[0]).toMatchObject({ status: 'delivered', entryId: 'native-entry' });
});
it('cancels while the enqueue acknowledgment is pending without ever dispatching to Pi', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(async (value) => { if (value.status === 'queued') await hold; });
  const enqueue = f.queue.enqueue(input);
  await vi.waitFor(() => expect(f.queue.snapshot()).toHaveLength(1));
  expect((await f.queue.cancel(input.id)).cancelled).toBe(true);
  release(); expect((await enqueue).status).toBe('cancelled');
  expect(f.native.queueInput).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
});
it('does not report cancellation if native consumption already won', async () => {
  const f = fixture(); await f.queue.enqueue(input);
  f.native.cancelQueuedInput.mockReturnValue(false);
  expect((await f.queue.cancel(input.id)).cancelled).toBe(false);
  expect(f.queue.snapshot()[0]?.status).toBe('queued');
});
it('rejects changed scope at actual selection without changing intent', async () => {
  const f = fixture(); await f.queue.enqueue(input); f.changeAuthorization();
  await expect(f.queue.selected({ ...input })).rejects.toThrow('未获得后端确认');
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.queue.snapshot()[0]).toMatchObject({ status: 'failed', reason: 'authorization-changed' });
  expect(f.failed).toHaveBeenCalledOnce();
});
it('does not authorize history when persistence rejects the native delivery receipt', async () => {
  const f = fixture(async (value) => { if (value.status === 'delivered') throw new Error('private disk details'); });
  await f.queue.enqueue(input); await f.queue.selected(input);
  await expect(f.queue.delivered(input.id, 'native-entry')).rejects.toThrow('历史回执未获得确认');
  expect(f.queue.snapshot()[0]).toMatchObject({ status: 'failed', reason: 'delivery-failed' });
  expect(f.queue.allowsHistory(input.id)).toBe(false); expect(f.failed).toHaveBeenCalledOnce();
});
it('dispatches a concurrent duplicate ID only once after both persistence acknowledgments', async () => {
  let release!: () => void, commits = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(async (value) => { if (value.status === 'queued') { commits++; await hold; } });
  const first = f.queue.enqueue(input), second = f.queue.enqueue(input);
  await vi.waitFor(() => expect(commits).toBe(2)); release();
  await Promise.all([first, second]); expect(f.native.queueInput).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled(); expect(f.queue.snapshot()).toHaveLength(1);
});
it('does not activate an input stopped during its selection acknowledgment', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(async (value) => { if (value.status === 'delivering') await hold; });
  await f.queue.enqueue(input);
  const selected = f.queue.selected(input), rejected = expect(selected).rejects.toThrow('未获得后端确认');
  await f.queue.stop(); expect(f.queue.snapshot()[0]?.status).toBe('failed');
  release(); await rejected; expect(f.activate).not.toHaveBeenCalled();
  expect(f.native.queueInput).toHaveBeenCalledOnce();
});
it('expires pending native inputs without waking a model', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.queue.enqueue(input);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.queue.snapshot()[0]).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(f.native.cancelQueuedInput).toHaveBeenCalledExactlyOnceWith('input');
    expect(f.activate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('does not silently start a new model turn when the old run settled during persistence', async () => {
  const f = fixture(); f.native.isStreaming = false;
  await expect(f.queue.enqueue(input)).rejects.toThrow('未投递');
  expect(f.native.queueInput).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledOnce();
  expect(f.queue.snapshot()[0]?.status).toBe('failed');
});
