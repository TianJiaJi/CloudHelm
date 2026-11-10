import { expect, it, vi } from 'vitest';
import { ConversationInputQueue } from '@cloudhelm/application';
import type { NewConversationInput } from '@cloudhelm/core';
const input = (id: string, kind: NewConversationInput['kind'] = 'steer'): NewConversationInput => ({
  id, kind, text: 'same text', intent: 'synthetic intent', authorizationKey: 'scope-v1'
});
function fixture(capacity = 64) {
  let at = 100;
  const persist = vi.fn(), queue = new ConversationInputQueue('task', persist, () => at, 1000, capacity);
  return { queue, persist, advance: (ms: number) => { at += ms; } };
}
it('keeps identical text in separate steer/followUp receipts without changing intent or delivering', () => {
  const f = fixture();
  const a = f.queue.enqueue(input('a', 'followUp')), b = f.queue.enqueue(input('b', 'steer'));
  expect([a.status, b.status]).toEqual(['queued', 'queued']);
  expect(f.queue.snapshot().map((entry) => entry.id)).toEqual(['a', 'b']);
  f.queue.beginDelivery('b', 'scope-v1'); f.queue.delivered('b', 'native-b');
  expect(f.queue.get('a')?.status).toBe('queued');
  expect(f.queue.get('b')).toMatchObject({ status: 'delivered', entryId: 'native-b' });
});
it('does not requeue a cancelled ID or allow it to acquire another body', () => {
  const f = fixture(); f.queue.enqueue(input('a'));
  expect(f.queue.cancel('a').cancelled).toBe(true);
  expect(f.queue.enqueue(input('a')).status).toBe('cancelled');
  expect(() => f.queue.enqueue({ ...input('a'), text: 'different' })).toThrow('already bound');
  expect(() => f.queue.beginDelivery('a', 'scope-v1')).toThrow('no longer pending');
});
it('distinguishes cancellation from an input already selected for delivery', () => {
  const f = fixture(); f.queue.enqueue(input('a')); f.queue.beginDelivery('a', 'scope-v1');
  expect(f.queue.cancel('a')).toMatchObject({ cancelled: false, value: { status: 'delivering' } });
  f.queue.delivered('a', 'native-a');
  expect(f.queue.cancel('a')).toMatchObject({ cancelled: false, value: { status: 'delivered' } });
  expect(f.queue.delivered('a', 'native-a').entryId).toBe('native-a');
  expect(() => f.queue.delivered('a', 'foreign')).toThrow('receipt');
});
it('expires pending work and refuses changed authorization at consumption', () => {
  const f = fixture(); f.queue.enqueue(input('a')); f.queue.enqueue(input('b'));
  expect(() => f.queue.beginDelivery('a', 'scope-v2')).toThrow('authorization changed');
  expect(f.queue.get('a')).toMatchObject({ status: 'failed', reason: 'authorization-changed' });
  f.advance(1000); expect(() => f.queue.beginDelivery('b', 'scope-v1')).toThrow('no longer pending');
  expect(f.queue.get('b')).toMatchObject({ status: 'expired', reason: 'expired' });
});
it('does not revive queued, delivering or cancelled work on offline restoration', () => {
  const f = fixture(); for (const id of ['queued', 'delivering', 'cancelled', 'delivered']) f.queue.enqueue(input(id));
  f.queue.beginDelivery('delivering', 'scope-v1'); f.queue.cancel('cancelled');
  f.queue.beginDelivery('delivered', 'scope-v1'); f.queue.delivered('delivered', 'native');
  const restored = fixture(); restored.queue.restore(f.queue.snapshot());
  expect(restored.queue.snapshot().map((entry) => entry.status)).toEqual(['expired', 'expired', 'cancelled', 'delivered']);
  expect(restored.queue.get('queued')?.reason).toBe('recovered');
});
it('does not mutate canonical state if saving a transition fails', () => {
  const f = fixture(); f.queue.enqueue(input('a'));
  f.persist.mockImplementationOnce(() => { throw new Error('storage failed'); });
  expect(() => f.queue.beginDelivery('a', 'scope-v1')).toThrow('storage failed');
  expect(f.queue.get('a')?.status).toBe('queued');
  f.persist.mockImplementationOnce(() => { throw new Error('storage failed'); });
  expect(() => f.queue.cancel('a')).toThrow('storage failed');
  expect(f.queue.get('a')?.status).toBe('queued');
});
it('bounds live capacity while keeping terminal IDs protected from replay', () => {
  const f = fixture(1); f.queue.enqueue(input('a'));
  expect(() => f.queue.enqueue(input('b'))).toThrow('full');
  f.queue.cancel('a'); f.queue.enqueue(input('b'));
  expect(f.queue.enqueue(input('a')).status).toBe('cancelled');
});
it('returns detached values and rejects foreign or duplicate history', () => {
  const f = fixture(), saved = f.queue.enqueue(input('a')); saved.text = 'mutated';
  f.queue.snapshot()[0]!.status = 'delivered';
  expect(f.queue.get('a')).toMatchObject({ text: 'same text', status: 'queued' });
  expect(() => fixture().queue.restore([{ ...saved, taskId: 'foreign' }])).toThrow('history');
  expect(() => fixture().queue.restore([saved, saved])).toThrow('history');
});
