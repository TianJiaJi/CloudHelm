import { describe, expect, it } from 'vitest';
import { normalizeMenuEntries, type ContextMenuEntry } from './context-menu.js';

const action = (id: string): ContextMenuEntry => ({ id, label: id, run: () => undefined });
const separator = (id: string): ContextMenuEntry => ({ id, separator: true });

describe('context menu entries', () => {
  it('keeps plain action sequences untouched', () => {
    expect(normalizeMenuEntries([action('a'), action('b')]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('drops leading, trailing and repeated separators left behind by hidden items', () => {
    const entries = [separator('s1'), action('a'), separator('s2'), separator('s3'), action('b'), separator('s4')];
    expect(normalizeMenuEntries(entries).map((entry) => entry.id)).toEqual(['a', 's2', 'b']);
  });

  it('collapses a menu that only holds separators', () => {
    expect(normalizeMenuEntries([separator('s1'), separator('s2')])).toEqual([]);
  });
});
