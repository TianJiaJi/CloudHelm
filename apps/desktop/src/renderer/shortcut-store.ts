import { create } from 'zustand';
import { defaultBindings, isMacPlatform, type ShortcutActionId, type ShortcutBindings } from './shortcuts.js';

interface ShortcutState {
  /**
   * Effective bindings for every bindable action. An empty string means the
   * action is explicitly unbound, which is how "清除" differs from "默认值".
   */
  bindings: ShortcutBindings;
  enabled: boolean;
  /** True while the settings page is recording a new combination. */
  recording: boolean;
  loaded: boolean;
  load(): Promise<void>;
  setBinding(id: ShortcutActionId, binding: string | undefined): Promise<void>;
  resetBinding(id: ShortcutActionId): Promise<void>;
  resetAll(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  setRecording(recording: boolean): void;
}

const isMac = isMacPlatform();

async function persist(bindings: ShortcutBindings, enabled: boolean): Promise<void> {
  await window.cloudhelm.saveShortcuts({ bindings: { ...bindings }, enabled });
}

function resetAction(bindings: ShortcutBindings, id: ShortcutActionId): ShortcutBindings {
  return { ...bindings, [id]: defaultBindings(isMac)[id] ?? '' };
}

export const useShortcuts = create<ShortcutState>((set, get) => ({
  bindings: defaultBindings(isMac),
  enabled: true,
  recording: false,
  loaded: false,
  async load() {
    try {
      const stored = await window.cloudhelm.shortcuts();
      // Stored values win over defaults, so a cleared action stays cleared.
      set({ bindings: { ...defaultBindings(isMac), ...stored.bindings } as ShortcutBindings,
        enabled: stored.enabled, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async setBinding(id, binding) {
    const next = { ...get().bindings, [id]: binding ?? '' };
    set({ bindings: next });
    await persist(next, get().enabled);
  },
  async resetBinding(id) {
    const next = resetAction(get().bindings, id);
    set({ bindings: next });
    await persist(next, get().enabled);
  },
  async resetAll() {
    const next = defaultBindings(isMac);
    set({ bindings: next });
    await persist(next, get().enabled);
  },
  async setEnabled(enabled) {
    set({ enabled });
    await persist(get().bindings, enabled);
  },
  setRecording(recording) { set({ recording }); }
}));
