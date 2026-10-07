import { useEffect, useRef } from 'react';
import { useShortcuts } from './shortcut-store.js';
import {
  actionApplies, bindingFromEvent, BINDABLE_ACTIONS, shortcutContext, type ShortcutHandlers
} from './shortcuts.js';

/**
 * Single capture-phase listener for every shortcut action, so a matched
 * binding never reaches the xterm session or a text field unchanged.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const { bindings, enabled, recording } = useShortcuts.getState();
      if (!enabled || recording) return;
      const context = shortcutContext(event.target);
      const captured = bindingFromEvent(event);
      if (!captured) return;
      for (const action of BINDABLE_ACTIONS) {
        if (!actionApplies(action, context) || bindings[action.id] !== captured) continue;
        const handler = latest.current[action.id];
        if (!handler) continue;
        event.preventDefault();
        event.stopPropagation();
        handler();
        return;
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
