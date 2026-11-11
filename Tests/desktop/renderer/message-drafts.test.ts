import { expect, it } from 'vitest';
import { draftFor, finishDraftRequest, insertTerminalReference, longPaste, replaceParts, useMessageDrafts } from '../../../apps/desktop/src/renderer/message-drafts.js';
it('keeps authoritative summary counts for retries but clears them for a different send request', () => {
  const drafts = useMessageDrafts.getState();
  drafts.set('budget-progress', { request: { id: 'first', revision: '1' }, summaryRequests: { used: 32, limit: 32 } });
  drafts.set('budget-progress', { request: { id: 'first', revision: '1' }, locked: true });
  expect(draftFor('budget-progress').summaryRequests?.used).toBe(32);
  drafts.set('budget-progress', { request: { id: 'second', revision: '2' } });
  expect(draftFor('budget-progress').summaryRequests).toBeUndefined();
});
it('does not let an old send finalizer unlock a new draft or another request', () => {
  const key = 'late-finalizer'; useMessageDrafts.getState().set(key, { locked: true, request: { id: 'old', revision: 'old' } });
  const epoch = draftFor(key).epoch;
  useMessageDrafts.getState().clear(key);
  useMessageDrafts.getState().set(key, { locked: true, request: { id: 'new', revision: 'new' } });
  finishDraftRequest(key, epoch, 'old'); expect(draftFor(key).locked).toBe(true);
  finishDraftRequest(key, draftFor(key).epoch, 'old'); expect(draftFor(key).locked).toBe(true);
  finishDraftRequest(key, draftFor(key).epoch, 'new'); expect(draftFor(key).locked).toBe(false);
});
it('refuses a terminal quote captured before clear even when the new draft is unlocked', () => {
  const key = 'late-quote', epoch = draftFor(key).epoch; useMessageDrafts.getState().clear(key);
  expect(() => insertTerminalReference(key, { id: 'terminal', kind: 'terminal', capturedAt: 1 }, epoch)).toThrow('迟到引用');
  expect(draftFor(key).parts).toEqual([]);
});
it('folds pastes only above the agreed thresholds including Unicode characters', () => {
  expect(longPaste('中'.repeat(1000))).toBe(false); expect(longPaste('中'.repeat(1001))).toBe(true);
  expect(longPaste('😀'.repeat(1000))).toBe(false);
  expect(longPaste(Array(10).fill('a').join('\n'))).toBe(false); expect(longPaste(Array(11).fill('a').join('\r\n'))).toBe(true);
});
it('replaces a selection with an atomic reference while preserving surrounding text', () => {
  const ref = { type: 'reference' as const, reference: { id: 'a', kind: 'paste' as const, capturedAt: 1 }, content: 'body' };
  const parts = replaceParts([{ type: 'text', text: 'before REMOVE after' }], 7, 13, [ref]);
  expect(parts).toEqual([{ type: 'text', text: 'before ' }, ref, { type: 'text', text: ' after' }]);
});
it('routes delayed quotes to the captured draft and refuses mutations during sending', () => {
  useMessageDrafts.getState().set('first', { parts: [{ type: 'text', text: 'ab' }], caret: 1 });
  useMessageDrafts.getState().set('second', { parts: [{ type: 'text', text: 'other' }], caret: 5 });
  insertTerminalReference('first', { id: 't', kind: 'terminal', capturedAt: 1 });
  expect(draftFor('first').parts.map((p) => p.type)).toEqual(['text', 'reference', 'text']);
  expect(draftFor('second').parts).toEqual([{ type: 'text', text: 'other' }]);
  useMessageDrafts.getState().set('first', { locked: true });
  expect(() => insertTerminalReference('first', { id: 't2', kind: 'terminal', capturedAt: 1 })).toThrow('正在发送');
});
