import { describe, expect, it } from 'vitest';
import {
  actionApplies, bindingConflict, bindingFromEvent, bindingLabel, defaultBindings, formatBinding,
  isReservedBinding, keyToken, matchesBinding, menuHint, parseBinding, SHORTCUT_ACTION_MAP,
  type ShortcutAction
} from './shortcuts.js';

const key = (value: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', true>> = {}) =>
  ({ key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

describe('shortcut bindings', () => {
  it('keeps the lean default table and ships terminal defaults', () => {
    const bindings = defaultBindings(false);
    expect(bindings['terminal.new']).toBe('ctrl+shift+t');
    expect(bindings['tab.close']).toBe('ctrl+w');
    expect(bindings['conversation.new']).toBe('ctrl+n');
    expect(bindings['terminal.copy']).toBe('ctrl+shift+c');
    expect(bindings['terminal.paste']).toBe('ctrl+shift+v');
    expect(bindings['terminal.selectAll']).toBe('ctrl+shift+a');
    expect(bindings['terminal.clear']).toBe('ctrl+shift+k');
    expect(bindings['terminal.quote']).toBe('ctrl+shift+q');
    expect(bindings['agent.toggle']).toBeUndefined();
    expect(defaultBindings(true)['terminal.new']).toBe('meta+shift+t');
    expect(defaultBindings(true)['tab.close']).toBe('meta+w');
    expect(defaultBindings(true)['terminal.copy']).toBe('meta+shift+c');
    expect(defaultBindings(true)['terminal.clear']).toBe('meta+shift+k');
  });

  it('captures canonical bindings and refuses modifier-only or unmodified typing', () => {
    expect(bindingFromEvent(key('T', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+t');
    expect(bindingFromEvent(key('Control', { ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(key('A', { shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(key('a'))).toBeNull();
    expect(bindingFromEvent(key('F1'))).toBe('f1');
    expect(bindingFromEvent(key('ArrowDown', { ctrlKey: true }))).toBe('ctrl+down');
    expect(bindingFromEvent(key(',', { metaKey: true }))).toBe('meta+,');
  });

  it('matches events against stored bindings including modifier order', () => {
    expect(matchesBinding(key('W', { ctrlKey: true }) as KeyboardEvent, 'ctrl+w')).toBe(true);
    expect(matchesBinding(key('W', { ctrlKey: true }) as KeyboardEvent, 'ctrl+shift+w')).toBe(false);
    expect(matchesBinding(key('W', { ctrlKey: true }) as KeyboardEvent, '')).toBe(false);
  });

  it('formats platform labels and rejects unparsable bindings', () => {
    expect(formatBinding('ctrl+shift+t', false)).toBe('Ctrl+Shift+T');
    expect(formatBinding('ctrl+alt+delete', false)).toBe('Ctrl+Alt+Del');
    expect(formatBinding('meta+shift+t', true)).toBe('⇧⌘T');
    expect(formatBinding('ctrl+down', false)).toBe('Ctrl+↓');
    expect(formatBinding('', false)).toBe('');
    expect(formatBinding('mod+t', false)).toBe('');
    expect(formatBinding(undefined, false)).toBe('');
    expect(parseBinding('ctrl+')).toBeNull();
    expect(parseBinding('hyper+t')).toBeNull();
  });

  it('protects native editing keys and reports the conflicting action', () => {
    expect(isReservedBinding('ctrl+c', false)).toBe(true);
    expect(isReservedBinding('meta+c', true)).toBe(true);
    expect(isReservedBinding('ctrl+shift+t', false)).toBe(false);
    expect(bindingConflict({ 'tab.close': 'ctrl+w' }, 'terminal.new', 'ctrl+c', false)).toEqual({ kind: 'reserved' });
    expect(bindingConflict({ 'tab.close': 'ctrl+w' }, 'terminal.new', 'ctrl+w', false))
      .toEqual({ kind: 'taken', actionId: 'tab.close', label: '关闭当前标签' });
    expect(bindingConflict({ 'tab.close': 'ctrl+w' }, 'tab.close', 'ctrl+w', false)).toBeNull();
    expect(bindingConflict({}, 'terminal.new', 'ctrl+shift+n', false)).toBeNull();
    expect(bindingConflict(defaultBindings(false), 'terminal.clear', 'ctrl+shift+c', false))
      .toEqual({ kind: 'taken', actionId: 'terminal.copy', label: '复制选中内容' });
  });

  it('scopes actions to the surface that owns them', () => {
    const terminalClear = SHORTCUT_ACTION_MAP['terminal.clear'] as ShortcutAction;
    const newTerminal = SHORTCUT_ACTION_MAP['terminal.new'] as ShortcutAction;
    const copy = SHORTCUT_ACTION_MAP['edit.copy'] as ShortcutAction;
    expect(actionApplies(terminalClear, 'terminal')).toBe(true);
    expect(actionApplies(terminalClear, 'input')).toBe(false);
    expect(actionApplies(terminalClear, 'default')).toBe(false);
    expect(actionApplies(newTerminal, 'terminal')).toBe(true);
    expect(actionApplies(newTerminal, 'input')).toBe(true);
    expect(actionApplies(newTerminal, 'default')).toBe(true);
    expect(actionApplies(copy, 'input')).toBe(false);
  });

  it('labels unset actions and hides keys that cannot fire in a surface', () => {
    const bindings = { ...defaultBindings(false), 'terminal.clear': '' };
    expect(menuHint('terminal.clear', bindings, false, 'terminal')).toEqual({ hint: '未设置', muted: true });
    expect(menuHint('terminal.clear', bindings, false, 'input')).toBeUndefined();
    expect(menuHint('terminal.clear', bindings, false, 'default')).toBeUndefined();
    expect(menuHint('tab.close', bindings, false, 'default')).toEqual({ hint: 'Ctrl+W', muted: false });
    // Global actions now fire inside the terminal, so the menu advertises them there too.
    expect(menuHint('tab.close', bindings, false, 'terminal')).toEqual({ hint: 'Ctrl+W', muted: false });
    expect(menuHint('terminal.new', bindings, false, 'terminal')).toEqual({ hint: 'Ctrl+Shift+T', muted: false });
    expect(menuHint('terminal.copy', bindings, false, 'terminal')).toEqual({ hint: 'Ctrl+Shift+C', muted: false });
    expect(bindingLabel('terminal.new', bindings, false)).toBe('Ctrl+Shift+T');
    expect(bindingLabel('terminal.clear', bindings, false)).toBe('');
  });

  it('normalises key tokens for display and matching', () => {
    expect(keyToken('Escape')).toBe('escape');
    expect(keyToken(' ')).toBe('space');
    expect(keyToken('Shift')).toBe('');
    expect(keyToken('PageDown')).toBe('pagedown');
  });
});
