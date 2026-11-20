import { create } from 'zustand';
import type { StoredAppearanceSettings } from '@cloudhelm/contracts';

export type ThemeMode = StoredAppearanceSettings['mode'];
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode(mode: ThemeMode): void;
  /** Idempotent bootstrap: OS listener plus persisted mode reconciliation. */
  init(): void;
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(mode: ThemeMode): ResolvedTheme {
  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export const useTheme = create<ThemeState>((set, get) => ({
  // The preload resolved the persisted theme before first paint; mirror it.
  mode: 'system',
  resolved: typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  setMode: (mode) => {
    set({ mode, resolved: apply(mode) });
    void window.cloudhelm?.saveAppearanceSettings({ mode }).catch(() => undefined);
  },
  init: () => {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (get().mode === 'system') set({ resolved: apply('system') });
    });
    void window.cloudhelm?.appearanceSettings().then((settings) => {
      if (settings.mode !== get().mode) set({ mode: settings.mode, resolved: apply(settings.mode) });
    }).catch(() => undefined);
  }
}));
