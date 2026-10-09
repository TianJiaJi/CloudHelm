import { expect, it } from 'vitest';
import { draftFor, insertTerminalReference, longPaste, replaceParts, useMessageDrafts } from './message-drafts.js';
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
