import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceBody } from '@cloudhelm/core';

const stores: SqliteStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
const body = (id = 'original'): ReferenceBody => ({ reference: { id, kind: 'terminal', capturedAt: 1, hostId: 'host' }, original: 'synthetic terminal text' });
function setup() {
  const store = new SqliteStore(':memory:'); stores.push(store); store.beginReferenceSession('boot');
  store.put('hosts', 'host', { id: 'host' }); store.put('hosts', 'foreign', { id: 'foreign' });
  for (const id of ['task-a', 'task-b']) store.put('tasks', id, { id, hostIds: ['host'] });
  store.createReferenceDraft('draft-a', 'renderer', { conversationId: 'task-a', hostId: 'host' });
  store.createReferenceDraft('draft-b', 'renderer', { conversationId: 'task-b', hostId: 'host' });
  return store;
}

describe('E02: draft reference holds', () => {
  it('requires guarded startup and validates the canonical conversation target', () => {
    const store = new SqliteStore(':memory:'); stores.push(store);
    expect(() => store.createReferenceDraft('draft', 'renderer', { hostId: null })).toThrow('session unavailable');
    store.beginReferenceSession('boot'); store.put('tasks', 'task', { id: 'task', hostIds: [] });
    expect(() => store.createReferenceDraft('draft', 'renderer', { conversationId: 'missing', hostId: null })).toThrow('conversation unavailable');
    store.createReferenceDraft('draft', 'renderer', { conversationId: 'task', hostId: null });
    store.put('tasks', 'task', { id: 'task', hostIds: ['changed'] });
    expect(() => store.assertReferenceDraft('draft', 'renderer')).toThrow('target changed');
    store.releaseReferenceDraft('draft', 'renderer'); // Cleanup is still possible after a target change.
  });

  it('retains cross-draft copies when one conversation is deleted and collects the last hold', () => {
    const store = setup(); store.saveDraftReference('draft-a', 'renderer', body());
    store.claimDraftReferences('draft-b', 'renderer', ['original']);
    store.commitConversationDeletion('task-a', [], []);
    expect(() => store.assertReferenceDraft('draft-a', 'renderer')).toThrow('expired');
    store.assertDraftReference('draft-b', 'renderer', 'original'); expect(store.readReference('original')).toEqual(body());
    store.releaseReferenceDraft('draft-b', 'renderer'); expect(store.readReference('original')).toBeUndefined();
    store.releaseReferenceDraft('draft-b', 'renderer'); expect(store.get('tasks', 'task-b')).toBeDefined();
  });

  it('does not interpret an omitted visible reference as release of undo history', () => {
    const store = setup(); store.saveDraftReference('draft-a', 'renderer', body());
    store.claimDraftReferences('draft-a', 'renderer', []); store.claimDraftReferences('draft-a', 'renderer', ['original', 'original']);
    store.assertDraftReference('draft-a', 'renderer', 'original');
    store.releaseReferenceRecipient('renderer'); expect(store.readReference('original')).toBeUndefined();
  });

  it('rejects foreign recipients, targets and canonical terminal hosts without granting a hold', () => {
    const store = setup(); store.saveDraftReference('draft-a', 'renderer', body());
    expect(() => store.releaseReferenceDraft('draft-a', 'foreign-renderer')).toThrow('expired');
    expect(() => store.claimDraftReferences('draft-b', 'foreign-renderer', ['original'])).toThrow('expired');
    expect(() => store.assertReferenceDraft('draft-a', 'renderer', { conversationId: 'task-b', hostId: 'host' })).toThrow('mismatch');
    store.createReferenceDraft('foreign-draft', 'renderer', { hostId: 'foreign' });
    expect(() => store.claimDraftReferences('foreign-draft', 'renderer', ['original'])).toThrow('host does not match');
    store.releaseReferenceDraft('draft-a', 'renderer'); expect(store.readReference('original')).toBeUndefined();
  });

  it('atomically rolls back bodies and claimed sets when storage or a later id fails', () => {
    const store = setup(), put = store.putReference.bind(store);
    vi.spyOn(store, 'putReference').mockImplementation((id, value) => { put(id, value); throw new Error('synthetic storage failure'); });
    expect(() => store.saveDraftReference('draft-a', 'renderer', body())).toThrow('synthetic storage failure');
    expect(store.readReference('original')).toBeUndefined(); vi.restoreAllMocks();
    store.saveDraftReference('draft-a', 'renderer', body());
    expect(() => store.claimDraftReferences('draft-b', 'renderer', ['original', 'missing'])).toThrow('expired');
    store.releaseReferenceDraft('draft-a', 'renderer'); expect(store.readReference('original')).toBeUndefined();
  });

  it.each(['messages', 'conversation-inputs'])('keeps bodies still owned by %s when a draft closes', (bucket) => {
    const store = setup(); store.saveDraftReference('draft-a', 'renderer', body());
    store.put(bucket, 'record', { taskId: 'task-b', document: { parts: [{ type: 'reference', reference: body().reference }] } });
    store.releaseReferenceRecipient('renderer'); expect(store.readReference('original')).toBeDefined();
    store.commitConversationDeletion('task-b', [], []); expect(store.readReference('original')).toBeUndefined();
  });

  it('does not turn an unowned legacy original into collectible data by claiming it', () => {
    const store = setup(); store.putReference('legacy', body('legacy'));
    store.claimDraftReferences('draft-a', 'renderer', ['legacy']);
    store.commitConversationDeletion('task-a', [], []);
    expect(store.readReference('legacy')).toBeDefined();
    store.claimDraftReferences('draft-b', 'renderer', ['legacy']); store.releaseReferenceDraft('draft-b', 'renderer');
    expect(store.readReference('legacy')).toBeDefined();
  });

  it('remembers a released durable owner until the final draft closes', () => {
    const store = setup(); store.putReference('published', body('published'));
    store.put('messages', 'message', { taskId: 'task-a', document: { parts: [{ type: 'reference', reference: body('published').reference }] } });
    store.claimDraftReferences('draft-b', 'renderer', ['published']);
    store.commitConversationDeletion('task-a', [], []); expect(store.readReference('published')).toBeDefined();
    store.releaseReferenceDraft('draft-b', 'renderer'); expect(store.readReference('published')).toBeUndefined();
  });

  it('caps retained reference count and does not silently drop history to admit another reference', () => {
    const store = setup(); const ids = Array.from({ length: 1000 }, (_, index) => `reference-${index}`);
    for (const id of [...ids, 'overflow']) store.putReference(id, body(id));
    store.claimDraftReferences('draft-a', 'renderer', ids);
    expect(() => store.claimDraftReferences('draft-a', 'renderer', ['overflow'])).toThrow('capacity exceeded');
    store.assertDraftReference('draft-a', 'renderer', ids[0]!);
    store.releaseReferenceDraft('draft-a', 'renderer');
    expect(store.readReference(ids[0]!)).toBeDefined(); expect(store.readReference('overflow')).toBeDefined(); // Claims do not assign ownership to legacy originals.
  });
});
