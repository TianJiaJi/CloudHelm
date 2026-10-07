import { create } from 'zustand';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { IconName } from './ui-helpers.js';
import { MenuDivider, MenuItem, MenuSurface } from './menu-surface.js';

export interface ContextMenuAction {
  id: string;
  label: string;
  run(): void;
  icon?: IconName;
  /** Current shortcut for this action; omitted when nothing is bound. */
  hint?: string;
  /** True when `hint` is the muted "not set" placeholder. */
  hintMuted?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip shown instead of the label when a reason is needed. */
  title?: string;
}

export interface ContextMenuSeparator { id: string; separator: true }
export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

export function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return 'separator' in entry;
}

/** Drops leading, trailing and repeated separators so conditionally hidden items stay tidy. */
export function normalizeMenuEntries(entries: ContextMenuEntry[]): ContextMenuEntry[] {
  const result: ContextMenuEntry[] = [];
  for (const entry of entries) {
    if (isSeparator(entry)) {
      if (result.length && !isSeparator(result[result.length - 1]!)) result.push(entry);
      continue;
    }
    result.push(entry);
  }
  while (result.length && isSeparator(result[result.length - 1]!)) result.pop();
  return result;
}

interface ContextMenuRequest {
  x: number; y: number; label: string; entries: ContextMenuEntry[]; restoreFocus: HTMLElement | null;
}

interface ContextMenuState {
  request: ContextMenuRequest | null;
  open(request: ContextMenuRequest): void;
  close(): void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null })
}));

/** Opens a pointer menu from a React contextmenu handler; empty menus stay closed. */
export function openContextMenu(event: ReactMouseEvent, entries: ContextMenuEntry[], label: string): void {
  event.preventDefault();
  event.stopPropagation();
  const items = normalizeMenuEntries(entries);
  if (!items.length) return;
  useContextMenu.getState().open({ x: event.clientX, y: event.clientY, label, entries: items,
    restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
}

export function ContextMenuHost(): React.JSX.Element | null {
  const request = useContextMenu((state) => state.request);
  const close = useContextMenu((state) => state.close);
  if (!request) return null;
  return <MenuSurface anchor={{ x: request.x, y: request.y }} label={request.label} close={close} restoreFocus={request.restoreFocus}>
    <MenuEntryList entries={request.entries} close={close} />
  </MenuSurface>;
}

/** Renders the same entries inside an element-anchored menu. */
export function MenuEntryList({ entries, close }: { entries: ContextMenuEntry[]; close?(): void }): React.JSX.Element {
  return <>{normalizeMenuEntries(entries).map((entry) => isSeparator(entry)
    ? <MenuDivider key={entry.id} />
    : <MenuItem key={entry.id} label={entry.label} icon={entry.icon} hint={entry.hint} hintMuted={entry.hintMuted}
      danger={entry.danger} disabled={entry.disabled} title={entry.title} onSelect={() => { close?.(); entry.run(); }} />)}</>;
}
