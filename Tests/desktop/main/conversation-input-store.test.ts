import { afterEach, expect, it } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import { ConversationInputQueue } from '@cloudhelm/application';
import { ConversationInputStore } from '../../../apps/desktop/src/main/conversation-input-store.js';
const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  const authority = new ConversationInputStore(store, (id) => id === 'task');
  const queue = new ConversationInputQueue('task', (value) => authority.commit(value));
  return { store, authority, queue };
}
const input = (id: string) => ({ id, kind: 'followUp' as const, text: 'prepared reference body', intent: 'visible user intent', authorizationKey: 'scope',
  document: { requestId: id, parts: [{ type: 'text' as const, text: 'visible user intent' }] } });
it('persists versioned receipts and keeps prepared reference bodies out of snapshots', () => {
  const f = fixture(), value = f.queue.enqueue(input('a'));
  expect(f.store.get('conversation-inputs', 'a')).toEqual(value);
  expect(f.authority.snapshot()[0]).toMatchObject({ id: 'a', status: 'queued', preview: 'visible user intent' });
  expect(JSON.stringify(f.authority.snapshot())).not.toContain('prepared reference body');
  expect(JSON.stringify(f.authority.snapshot())).not.toContain('authorizationKey');
});
it('expires queued and in-delivery records on reload but preserves cancelled and delivered records', () => {
  const f = fixture(); for (const id of ['queued', 'selecting', 'cancelled', 'delivered']) f.queue.enqueue(input(id));
  f.queue.beginDelivery('selecting', 'scope'); f.queue.cancel('cancelled');
  f.queue.beginDelivery('delivered', 'scope'); f.queue.delivered('delivered', 'native');
  const restored = new ConversationInputStore(f.store, () => true);
  const statuses = Object.fromEntries(restored.list('task').map((value) => [value.id, value.status]));
  expect(statuses).toEqual({ queued: 'expired', selecting: 'expired', cancelled: 'cancelled', delivered: 'delivered' });
  expect(f.store.get('conversation-inputs', 'queued')).toMatchObject({ status: 'expired', reason: 'recovered' });
});
it('rejects changing recipient, request body or a terminal receipt back to pending', () => {
  const f = fixture(), original = f.queue.enqueue(input('a'));
  expect(() => f.authority.commit({ ...original, taskId: 'foreign' })).toThrow('owner');
  expect(() => f.authority.commit({ ...original, text: 'changed' })).toThrow('changed');
  f.queue.cancel('a'); expect(() => f.authority.commit(original)).toThrow('regressed');
  expect(f.store.get('conversation-inputs', 'a')).toMatchObject({ status: 'cancelled' });
});
it('invalidates pending work after worker loss without making a model request and removes only the deleted task', () => {
  const f = fixture(); f.queue.enqueue(input('a')); f.authority.invalidate();
  expect(f.authority.list('task')[0]).toMatchObject({ status: 'expired', reason: 'recovered' });
  f.authority.removeTask('task'); expect(f.authority.snapshot()).toEqual([]);
  expect(f.store.list('conversation-inputs')).toEqual([]);
});
