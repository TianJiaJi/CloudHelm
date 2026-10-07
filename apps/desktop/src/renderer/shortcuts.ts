export type ShortcutGroup = 'editing' | 'workspace' | 'agent' | 'terminal';
/** `fixed` actions are handled natively by the input and never rebound. */
export type ShortcutScope = 'global' | 'terminal' | 'fixed';

export type ShortcutActionId =
  | 'edit.copy' | 'edit.paste' | 'edit.cut' | 'edit.selectAll' | 'edit.undo' | 'edit.redo'
  | 'terminal.new' | 'conversation.new' | 'settings.open'
  | 'tab.close' | 'tab.closeOthers' | 'tab.closeAll' | 'tab.next' | 'tab.previous'
  | 'agent.toggle'
  | 'terminal.copy' | 'terminal.paste' | 'terminal.selectAll' | 'terminal.clear' | 'terminal.quote';

export interface ShortcutAction {
  id: ShortcutActionId;
  label: string;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** `mod` is the platform primary modifier: Ctrl on Windows/Linux, Command on macOS. */
  defaultBinding?: string;
}

export const SHORTCUT_GROUPS: Array<{ id: ShortcutGroup; label: string; description: string }> = [
  { id: 'editing', label: '编辑', description: '输入框内的系统级编辑操作，由界面原生处理，不支持修改。' },
  { id: 'workspace', label: '标签与窗口', description: '终端标签、对话与设置入口。' },
  { id: 'agent', label: 'AI 助手', description: '右侧 AI 助手面板。' },
  { id: 'terminal', label: '终端', description: '仅当焦点在 SSH 终端内时生效，避免抢占 shell 按键。' }
];

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'edit.copy', label: '复制', group: 'editing', scope: 'fixed', defaultBinding: 'mod+c' },
  { id: 'edit.paste', label: '粘贴', group: 'editing', scope: 'fixed', defaultBinding: 'mod+v' },
  { id: 'edit.cut', label: '剪切', group: 'editing', scope: 'fixed', defaultBinding: 'mod+x' },
  { id: 'edit.selectAll', label: '全选', group: 'editing', scope: 'fixed', defaultBinding: 'mod+a' },
  { id: 'edit.undo', label: '撤销', group: 'editing', scope: 'fixed', defaultBinding: 'mod+z' },
  { id: 'edit.redo', label: '重做', group: 'editing', scope: 'fixed', defaultBinding: 'mod+shift+z' },
  { id: 'terminal.new', label: '新终端', group: 'workspace', scope: 'global', defaultBinding: 'mod+shift+t' },
  { id: 'tab.close', label: '关闭当前标签', group: 'workspace', scope: 'global', defaultBinding: 'mod+w' },
  { id: 'tab.closeOthers', label: '关闭其他标签', group: 'workspace', scope: 'global' },
  { id: 'tab.closeAll', label: '关闭全部标签', group: 'workspace', scope: 'global' },
  { id: 'tab.next', label: '下一个标签', group: 'workspace', scope: 'global' },
  { id: 'tab.previous', label: '上一个标签', group: 'workspace', scope: 'global' },
  { id: 'conversation.new', label: '新对话', group: 'workspace', scope: 'global', defaultBinding: 'mod+n' },
  { id: 'settings.open', label: '打开设置', group: 'workspace', scope: 'global' },
  { id: 'agent.toggle', label: '切换 AI 助手面板', group: 'agent', scope: 'global' },
  { id: 'terminal.copy', label: '复制选中内容', group: 'terminal', scope: 'terminal' },
  { id: 'terminal.paste', label: '粘贴', group: 'terminal', scope: 'terminal' },
  { id: 'terminal.selectAll', label: '全选终端内容', group: 'terminal', scope: 'terminal' },
  { id: 'terminal.clear', label: '清屏（仅本地显示）', group: 'terminal', scope: 'terminal' },
  { id: 'terminal.quote', label: '引用输出到 AI', group: 'terminal', scope: 'terminal' }
];

export const SHORTCUT_ACTION_MAP: Record<string, ShortcutAction> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]));

/** Editing shortcuts stay native: rebinding them would break every text field. */
export const FIXED_EDITING_ACTIONS = SHORTCUT_ACTIONS.filter((action) => action.scope === 'fixed');
export const BINDABLE_ACTIONS = SHORTCUT_ACTIONS.filter((action) => action.scope !== 'fixed');

/** Keyboard combinations the app refuses to bind so core semantics stay intact. */
const RESERVED_BINDINGS = ['mod+c', 'mod+v', 'mod+x', 'mod+a', 'mod+z', 'mod+shift+z'];

/** Shown in menus next to actions that have no shortcut bound. */
export const UNSET_LABEL = '未设置';

export type ShortcutBindings = Partial<Record<ShortcutActionId, string>>;
export interface StoredShortcuts { bindings: ShortcutBindings; enabled: boolean }

export type ShortcutContext = 'terminal' | 'input' | 'default';

export function isMacPlatform(source?: { platform?: string; userAgent?: string }): boolean {
  const value = source ?? (typeof navigator === 'undefined' ? {} : navigator);
  return /mac|iphone|ipad/iu.test(`${value.platform ?? ''} ${value.userAgent ?? ''}`);
}

/** Expands `mod` into the platform primary modifier using the canonical modifier order. */
export function resolveDefaultBinding(binding: string | undefined, isMac: boolean): string | undefined {
  if (!binding) return undefined;
  return binding.replace('mod', isMac ? 'meta' : 'ctrl');
}

export function defaultBindings(isMac: boolean): ShortcutBindings {
  const bindings: ShortcutBindings = {};
  for (const action of BINDABLE_ACTIONS) {
    const binding = resolveDefaultBinding(action.defaultBinding, isMac);
    if (binding) bindings[action.id] = binding;
  }
  return bindings;
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space', spacebar: 'space', esc: 'escape', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  return: 'enter', del: 'delete', ins: 'insert', plus: '+', '-': '-'
};
const MODIFIER_KEYS = ['control', 'shift', 'alt', 'meta', 'altgraph', 'capslock', 'numlock', 'scrolllock', 'dead', 'unidentified'];

/** Canonical key token for a `KeyboardEvent.key`; empty for bare modifiers. */
export function keyToken(key: string): string {
  const lower = key.toLowerCase();
  if (MODIFIER_KEYS.includes(lower)) return '';
  const alias = KEY_ALIASES[lower];
  return alias ?? lower;
}

/** Canonical binding string in the fixed modifier order ctrl, alt, shift, meta. */
export function bindingFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const key = keyToken(event.key);
  if (!key) return null;
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  if (!modified && !/^f\d{1,2}$/u.test(key)) return null;
  return [...event.ctrlKey ? ['ctrl'] : [], ...event.altKey ? ['alt'] : [], ...event.shiftKey ? ['shift'] : [],
    ...event.metaKey ? ['meta'] : [], key].join('+');
}

export interface ParsedBinding { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  if (!key) return null;
  const parsed: ParsedBinding = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const part of parts) {
    if (part === 'mod') return null;
    if (!['ctrl', 'alt', 'shift', 'meta'].includes(part)) return null;
    parsed[part as 'ctrl' | 'alt' | 'shift' | 'meta'] = true;
  }
  return parsed;
}

const KEY_LABELS: Record<string, string> = {
  up: '↑', down: '↓', left: '←', right: '→', escape: 'Esc', space: 'Space', tab: 'Tab', enter: 'Enter',
  delete: 'Del', insert: 'Ins', pageup: 'PgUp', pagedown: 'PgDn', backspace: 'Backspace'
};

export function formatBinding(binding: string | undefined, isMac: boolean): string {
  if (!binding) return '';
  const parsed = parseBinding(binding);
  if (!parsed) return '';
  const key = KEY_LABELS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.replace(/^(f\d{1,2})$/u, (value) => value.toUpperCase()));
  if (isMac) {
    return `${parsed.ctrl ? '⌃' : ''}${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.meta ? '⌘' : ''}${key}`;
  }
  return [...parsed.ctrl ? ['Ctrl'] : [], ...parsed.alt ? ['Alt'] : [], ...parsed.shift ? ['Shift'] : [],
    ...parsed.meta ? ['Win'] : [], key].join('+');
}

export function matchesBinding(event: KeyboardEvent, binding: string | undefined): boolean {
  const captured = bindingFromEvent(event);
  return !!captured && captured === binding;
}

export function isReservedBinding(binding: string, isMac: boolean): boolean {
  const canonical = binding.toLowerCase();
  return RESERVED_BINDINGS.some((reserved) => resolveDefaultBinding(reserved, isMac) === canonical);
}

export type BindingConflict = { kind: 'reserved' } | { kind: 'taken'; actionId: ShortcutActionId; label: string };

/** A binding must be unique across bindable actions and must not shadow native editing keys. */
export function bindingConflict(bindings: ShortcutBindings, actionId: ShortcutActionId, binding: string, isMac: boolean): BindingConflict | null {
  if (isReservedBinding(binding, isMac)) return { kind: 'reserved' };
  for (const action of BINDABLE_ACTIONS) {
    if (action.id === actionId) continue;
    if (bindings[action.id]?.toLowerCase() === binding.toLowerCase()) return { kind: 'taken', actionId: action.id, label: action.label };
  }
  return null;
}

export function shortcutContext(target: EventTarget | null): ShortcutContext {
  if (!(target instanceof HTMLElement)) return 'default';
  if (target.closest('[data-shortcut-scope="terminal"]')) return 'terminal';
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return 'input';
  return 'default';
}

export function actionApplies(action: ShortcutAction, context: ShortcutContext): boolean {
  if (action.scope === 'fixed') return false;
  return context === 'terminal' ? action.scope === 'terminal' : action.scope === 'global';
}

export function bindingLabel(actionId: ShortcutActionId, bindings: ShortcutBindings, isMac: boolean): string {
  const action = SHORTCUT_ACTION_MAP[actionId];
  if (!action) return '';
  const binding = bindings[actionId] ?? resolveDefaultBinding(action.defaultBinding, isMac);
  return formatBinding(binding, isMac);
}

export interface MenuHint { hint: string; muted: boolean }

/**
 * Shortcut hint for a menu row. Returns nothing when the action cannot fire in
 * this surface, so menus never advertise a key that does not work there. When
 * shortcuts are switched off the hint stays visible but muted.
 */
export function menuHint(actionId: ShortcutActionId, bindings: ShortcutBindings, isMac: boolean,
  context: ShortcutContext, enabled = true): MenuHint | undefined {
  const action = SHORTCUT_ACTION_MAP[actionId];
  if (!action || !actionApplies(action, context)) return undefined;
  const label = bindingLabel(actionId, bindings, isMac);
  if (!enabled) return { hint: label || UNSET_LABEL, muted: true };
  return label ? { hint: label, muted: false } : { hint: UNSET_LABEL, muted: true };
}

export type ShortcutHandlers = Partial<Record<ShortcutActionId, () => void>>;
