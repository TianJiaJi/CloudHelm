import { expect, it, vi } from 'vitest';
import type { MessagePart } from '@cloudhelm/contracts';
import { draftFor, useMessageDrafts } from '../../../apps/desktop/src/renderer/message-drafts.js';
import { discardReferenceDraft, holdDraftReferences } from '../../../apps/desktop/src/renderer/reference-drafts.js';

it('does not retry a failed explicit discard as background cleanup before sending the still-visible draft', async () => {
  const api = { openReferenceDraft: vi.fn(async () => 'lease'), claimDraftReferences: vi.fn(async () => {}), releaseReferenceDraft: vi.fn(async () => {}) };
  vi.stubGlobal('window', { cloudhelm: api });
  const key = 'retained-after-failed-discard', scope = { hostId: null };
  const parts: MessagePart[] = [{ type: 'reference', reference: { id: 'synthetic-body', kind: 'paste', capturedAt: 1 } }];
  try {
    useMessageDrafts.getState().set(key, { parts }); await holdDraftReferences(key, scope, parts);
    api.releaseReferenceDraft.mockRejectedValueOnce(new Error('synthetic transaction rolled back'));
    await expect(discardReferenceDraft(key)).rejects.toThrow('synthetic transaction rolled back');
    expect(draftFor(key).parts).toEqual(parts); expect(draftFor(key).locked).toBe(false);
    await holdDraftReferences(key, scope, parts, true);
    expect(api.releaseReferenceDraft).toHaveBeenCalledTimes(1);
    expect(draftFor(key).parts).toEqual(parts);
  } finally {
    useMessageDrafts.getState().clear(key); await Promise.resolve();
    await Promise.allSettled(api.releaseReferenceDraft.mock.results.map((result) => result.value)); vi.unstubAllGlobals();
  }
});
