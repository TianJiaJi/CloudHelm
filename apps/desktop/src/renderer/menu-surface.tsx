import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './ui-helpers.js';
import styles from './ui.module.css';

/** Element bounds or a pointer position in viewport coordinates. */
export type MenuAnchor = HTMLElement | { x: number; y: number };

const MARGIN = 8;

/**
 * Shared menu surface for anchored and pointer menus. The native popover top
 * layer escapes sidebar scrolling and clipping; positioning stays in the
 * viewport so menus opened near an edge remain fully readable.
 */
export function MenuSurface({ anchor, label, children, close, restoreFocus, className, placement, searchFocus, align }: {
  anchor: MenuAnchor; label: string; children: ReactNode; close(): void; restoreFocus?: HTMLElement | null;
  className?: string; placement?: 'above'; searchFocus?: boolean; align?: 'start';
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pointer = anchor instanceof HTMLElement ? null : anchor;
  const element = anchor instanceof HTMLElement ? anchor : null;
  // Depend on primitives: a re-render of the host must not re-open the menu
  // (live terminal output re-renders the app constantly), which would steal
  // focus back to the first row on every update.
  const anchorKey = element ? 'element' : `${pointer?.x ?? 0}:${pointer?.y ?? 0}`;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const focusTarget = element ?? restoreFocus ?? null;
    function clamp(value: number, size: number): number {
      return Math.max(MARGIN, Math.min(value, window.innerWidth - size - MARGIN));
    }
    function clampTop(value: number, size: number): number {
      return Math.max(MARGIN, Math.min(value, window.innerHeight - size - MARGIN));
    }
    function position(): void {
      if (element) {
        const bounds = element.getBoundingClientRect();
        const below = bounds.bottom + 5;
        menu.style.left = `${clamp(align === 'start' ? bounds.left : bounds.right - menu.offsetWidth, menu.offsetWidth)}px`;
        menu.style.top = `${clampTop(placement !== 'above' && below + menu.offsetHeight <= window.innerHeight - MARGIN ? below : bounds.top - menu.offsetHeight - 5, menu.offsetHeight)}px`;
      } else if (pointer) {
        const left = pointer.x + menu.offsetWidth + MARGIN <= window.innerWidth ? pointer.x : pointer.x - menu.offsetWidth;
        const top = pointer.y + menu.offsetHeight + MARGIN <= window.innerHeight ? pointer.y : pointer.y - menu.offsetHeight;
        menu.style.left = `${clamp(left, menu.offsetWidth)}px`;
        menu.style.top = `${clampTop(top, menu.offsetHeight)}px`;
      }
    }
    function dismissOnScroll(event: Event): void {
      // A pointer menu stays where the user right-clicked: content scrolling
      // underneath must not dismiss it, otherwise a smooth scroll animation
      // would close the menu the moment it opens. Element-anchored menus still
      // close so they never drift away from their anchor.
      if (pointer) return;
      if (!menu.contains(event.target as Node)) menu.hidePopover();
    }
    function dismissOnPointerDown(event: PointerEvent): void {
      if (!menu.contains(event.target as Node)) menu.hidePopover();
    }
    menu.showPopover();
    position();
    menu.querySelector<HTMLElement>(searchFocus ? 'input[type="search"]' : '[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', dismissOnScroll, true);
    if (pointer) window.addEventListener('pointerdown', dismissOnPointerDown, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('pointerdown', dismissOnPointerDown, true);
      menu.hidePopover();
      // Only take focus back when the menu currently owns it; a menu item that
      // opened a dialog must keep its own focus.
      const active = document.activeElement;
      if (!active || active === document.body || menu.contains(active)) focusTarget?.focus({ preventScroll: true });
    };
  }, [anchorKey, element, restoreFocus, placement, searchFocus, align]);

  // macOS fires contextmenu before pointerup. Auto popovers would dismiss on
  // that same opening gesture; pointer menus dismiss on the next pointerdown.
  return <div ref={ref} popover={pointer ? 'manual' : 'auto'} role="menu" aria-label={label} className={`${styles.menuSurface} ${className ?? ''}`}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onClick={(event) => { if ((event.target as Element).closest('[role="menuitem"]')) close(); }}
    onToggle={(event) => { if ((event.nativeEvent as ToggleEvent).newState === 'closed') close(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        (anchor instanceof HTMLElement ? anchor : restoreFocus)?.focus({ preventScroll: true });
        ref.current?.hidePopover();
        return;
      }
      const editingSearch = event.target instanceof HTMLInputElement;
      if (editingSearch && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : current < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }}>{children}</div>;
}

/** One selectable menu row: label on the left, shortcut hint on the right. */
export function MenuItem({ label, icon, hint, hintMuted, danger, disabled, title, onSelect }: {
  label: string; icon?: IconName; hint?: string; hintMuted?: boolean; danger?: boolean; disabled?: boolean; title?: string; onSelect(): void;
}): React.JSX.Element {
  return <button type="button" role="menuitem" className={danger ? styles.dangerText : undefined}
    disabled={disabled} title={title ?? label} onClick={onSelect}>
    {icon && <Icon name={icon} size={13} />}<span>{label}</span>
    {hint && <kbd className={`${styles.menuHint} ${hintMuted ? styles.menuHintMuted : ''}`}>{hint}</kbd>}
  </button>;
}

export function MenuDivider(): React.JSX.Element {
  return <div className={styles.menuDivider} role="separator" />;
}
