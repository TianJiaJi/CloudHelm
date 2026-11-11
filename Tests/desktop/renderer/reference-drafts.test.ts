import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessagePart } from '@cloudhelm/contracts';
import { draftFor, useMessageDrafts } from '../../../apps/desktop/src/renderer/message-drafts.js';
import { discardReferenceDraft, forgetConversationDrafts, holdDraftReferences } from '../../../apps/desktop/src/renderer/reference-drafts.js';

const keys = new Set<string>();
const scope = { conversationId: 'task', hostId: 'host' };
const parts: MessagePart[] = [{ type: 'reference', reference: { id: 'source', kind: 'terminal', capturedAt: 1, hostId: 'host' } }];
const api = { openReferenceDraft: vi.fn(async () => 'lease'), claimDraftReferences: vi.fn(async () => {}), releaseReferenceDraft: vi.fn(async () => {}) };
function key() { const id = crypto.randomUUID(); keys.add(id); return id; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.stubGlobal('window', { cloudhelm: api }); vi.resetAllMocks(); api.openReferenceDraft.mockResolvedValue('lease'); api.claimDraftReferences.mockResolvedValue(); api.releaseReferenceDraft.mockResolvedValue(); });
afterEach(async () => {
  api.releaseReferenceDraft.mockResolvedValue();
  for (const id of keys) useMessageDrafts.getState().clear(id);
  keys.clear(); await Promise.resolve();
  await Promise.allSettled(api.releaseReferenceDraft.mock.results.map((result) => result.value));
  vi.unstubAllGlobals();
});

it('coalesces lease creation and sends only reference ids, never the unredacted paste body', async () => {
  const id = key(), pasted: MessagePart = { type: 'reference', reference: { id: 'paste', kind: 'paste', capturedAt: 1 }, content: 'SYNTHETIC_PRIVATE_DRAFT' };
  await Promise.all([holdDraftReferences(id, scope, [...parts, pasted]), holdDraftReferences(id, scope, parts)]);
  expect(api.openReferenceDraft).toHaveBeenCalledTimes(1); expect(api.openReferenceDraft).toHaveBeenCalledWith(scope);
  expect(api.claimDraftReferences).toHaveBeenCalledWith('lease', ['source']);
  expect(JSON.stringify([api.openReferenceDraft.mock.calls, api.claimDraftReferences.mock.calls])).not.toContain(pasted.content);
});

it('releases a late lease instead of reviving a cleared draft', async () => {
  const id = key(), opened = deferred<string>(); api.openReferenceDraft.mockReturnValue(opened.promise);
  const hold = holdDraftReferences(id, scope, parts), rejected = expect(hold).rejects.toThrow('草稿已变化');
  await vi.waitFor(() => expect(api.openReferenceDraft).toHaveBeenCalledOnce());
  useMessageDrafts.getState().clear(id); opened.resolve('late'); await rejected;
  expect(api.releaseReferenceDraft).toHaveBeenCalledWith('late'); expect(draftFor(id).parts).toEqual([]);
});

it('rejects a claim acknowledgement after clear, without re-inserting the reference', async () => {
  const id = key(), claimed = deferred<void>(); api.claimDraftReferences.mockReturnValue(claimed.promise);
  const hold = holdDraftReferences(id, scope, parts), rejected = expect(hold).rejects.toThrow('草稿已变化');
  await vi.waitFor(() => expect(api.claimDraftReferences).toHaveBeenCalledOnce());
  useMessageDrafts.getState().clear(id); claimed.resolve(); await rejected;
  expect(draftFor(id).parts).toEqual([]); expect(api.releaseReferenceDraft).toHaveBeenCalledWith('lease');
});

it('retains the visible draft on explicit-discard failure and allows a deliberate retry', async () => {
  const id = key(); useMessageDrafts.getState().set(id, { parts }); await holdDraftReferences(id, scope, parts);
  api.releaseReferenceDraft.mockRejectedValueOnce(new Error('synthetic persistence failure'));
  await expect(discardReferenceDraft(id)).rejects.toThrow('synthetic persistence failure'); expect(draftFor(id).parts).toEqual(parts);
  await discardReferenceDraft(id); expect(draftFor(id).parts).toEqual([]);
});

it('locks the editor while an explicit discard is waiting for persistence', async () => {
  const id = key(), released = deferred<void>();
  useMessageDrafts.getState().set(id, { parts }); await holdDraftReferences(id, scope, parts);
  api.releaseReferenceDraft.mockReturnValue(released.promise);
  const discarding = discardReferenceDraft(id);
  try { expect(draftFor(id).locked).toBe(true); }
  finally { released.resolve(); await discarding; }
  expect(draftFor(id).parts).toEqual([]); expect(draftFor(id).locked).toBe(false);
});

it('keeps the lease while sending or canceling, but refuses new insertions into a locked draft', async () => {
  const id = key(); await holdDraftReferences(id, scope, parts); useMessageDrafts.getState().set(id, { locked: true });
  await expect(holdDraftReferences(id, scope, parts)).rejects.toThrow('正在发送');
  await expect(discardReferenceDraft(id)).rejects.toThrow('取消发送准备');
  expect(api.releaseReferenceDraft).not.toHaveBeenCalled();
  await expect(holdDraftReferences(id, scope, parts, true)).resolves.toBe('lease'); expect(api.openReferenceDraft).toHaveBeenCalledOnce();
});

it('invalidates a deleted conversation even when its lease opened before any editor state existed', async () => {
  const id = key(), opened = deferred<string>(); api.openReferenceDraft.mockReturnValue(opened.promise);
  const hold = holdDraftReferences(id, { conversationId: id, hostId: 'host' }, parts), rejected = expect(hold).rejects.toThrow('草稿已变化');
  await vi.waitFor(() => expect(api.openReferenceDraft).toHaveBeenCalledOnce());
  forgetConversationDrafts([id]); opened.resolve('late'); await rejected;
  expect(api.releaseReferenceDraft).toHaveBeenCalledWith('late'); expect(draftFor(id).parts).toEqual([]);
});
