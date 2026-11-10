import { expect, it, vi } from 'vitest';
import type { QueueAgent, NativeInputMessage as AgentMessage } from '../../packages/adapters/src/pi-input-queue.js';
import { PiInputQueue, type NativeQueuedInput } from '../../packages/adapters/src/pi-input-queue.js';
const input = (id: string, kind: NativeQueuedInput['kind'] = 'steer'): NativeQueuedInput => ({ id, kind, text: 'identical text' });
function fixture() {
  const native: AgentMessage[] = [], selected = vi.fn();
  const agent = { steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
    steer: vi.fn((message: AgentMessage) => { native.push(message); }),
    followUp: vi.fn((message: AgentMessage) => { native.push(message); }),
    clearAllQueues: vi.fn(() => { native.length = 0; }), peekQueuedMessages: () => [...native] };
  const queue = new PiInputQueue(agent as unknown as QueueAgent, selected);
  return { queue, agent, native, selected, take: () => native.shift()! };
}
it('uses native priority without confusing same-text inputs or duplicating followUp', async () => {
  const f = fixture(); f.queue.enqueue(input('later', 'followUp')); f.queue.enqueue(input('now'));
  expect(f.native).toHaveLength(1); await f.queue.observe(f.take());
  expect(f.selected).toHaveBeenNthCalledWith(1, input('now'));
  expect(f.native).toHaveLength(1); await f.queue.observe(f.take());
  expect(f.selected).toHaveBeenNthCalledWith(2, input('later', 'followUp'));
  expect(f.native).toHaveLength(0);
});
it('confirms cancellation only while the native slot is still pending', async () => {
  const f = fixture(); f.queue.enqueue(input('a')); f.queue.enqueue(input('b'));
  const selected = f.take();
  expect(f.queue.cancel('a')).toBe(false);
  expect(f.queue.cancel('b')).toBe(true);
  expect(f.agent.clearAllQueues).not.toHaveBeenCalled();
  await f.queue.observe(selected); expect(f.selected).toHaveBeenCalledExactlyOnceWith(input('a'));
  expect(f.native).toHaveLength(0);
});
it('removes a pending slot and never replays the cancelled ID', async () => {
  const f = fixture(); f.queue.enqueue(input('a')); f.queue.enqueue(input('b', 'followUp'));
  expect(f.queue.cancel('a')).toBe(true); expect(f.native).toHaveLength(1);
  expect(() => f.queue.enqueue(input('a'))).toThrow('repeated');
  await f.queue.observe(f.take()); expect(f.selected).toHaveBeenCalledExactlyOnceWith(input('b', 'followUp'));
});
it('keeps the imminent receipt when clearing races native consumption', async () => {
  const f = fixture(); f.queue.enqueue(input('selected')); f.queue.enqueue(input('pending'));
  const message = f.take();
  expect(f.queue.clear()).toEqual(['pending']);
  await f.queue.observe(message); expect(f.selected).toHaveBeenCalledExactlyOnceWith(input('selected'));
  expect(f.native).toHaveLength(0);
});
it('does not derive input identity from prose or a different session metadata nonce', async () => {
  const f = fixture(), foreign = fixture();
  f.queue.enqueue(input('a')); foreign.queue.enqueue(input('a'));
  await f.queue.observe({ role: 'user', content: [{ type: 'text', text: 'cloudhelm-queued-input a identical text' }], timestamp: 1 });
  await f.queue.observe(foreign.take());
  expect(f.selected).not.toHaveBeenCalled(); expect(f.native).toHaveLength(1);
  await f.queue.observe(f.take()); expect(f.selected).toHaveBeenCalledOnce();
});
it('does not arm additional work when the backend rejects a selected message', async () => {
  const f = fixture(); f.selected.mockImplementation(() => { throw new Error('authorization changed'); });
  f.queue.enqueue(input('a')); f.queue.enqueue(input('b'));
  await expect(f.queue.observe(f.take())).rejects.toThrow('authorization changed');
  expect(f.native).toHaveLength(0);
  expect(f.queue.clear()).toEqual(['b']);
});
