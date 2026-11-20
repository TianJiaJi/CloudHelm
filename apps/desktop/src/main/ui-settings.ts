import type { SqliteStore } from '@cloudhelm/adapters';
import type { StoredAppearanceSettings, StoredLayoutSettings } from '@cloudhelm/contracts';

const appearanceModes = ['system', 'light', 'dark'];
const layoutModes = ['ssh', 'agent'];

function isAppearanceMode(value: unknown): value is StoredAppearanceSettings['mode'] {
  return typeof value === 'string' && (appearanceModes as readonly string[]).includes(value);
}

function isLayoutMode(value: unknown): value is StoredLayoutSettings['mode'] {
  return typeof value === 'string' && (layoutModes as readonly string[]).includes(value);
}

/** Theme preference is local UI state stored in the settings bucket. */
export function appearanceSettings(store: SqliteStore): StoredAppearanceSettings {
  const stored = store.get<{ mode?: unknown }>('settings', 'appearance');
  return { mode: isAppearanceMode(stored?.mode) ? stored.mode : 'system' };
}

export function saveAppearanceSettings(store: SqliteStore, settings: StoredAppearanceSettings): void {
  if (!settings || typeof settings !== 'object' || !isAppearanceMode(settings.mode)) {
    throw new Error('无效的外观设置');
  }
  store.put('settings', 'appearance', { mode: settings.mode });
}

/** Layout mode is local UI state stored in the settings bucket. */
export function layoutSettings(store: SqliteStore): StoredLayoutSettings {
  const stored = store.get<{ mode?: unknown }>('settings', 'layout');
  return { mode: isLayoutMode(stored?.mode) ? stored.mode : 'ssh' };
}

export function saveLayoutSettings(store: SqliteStore, settings: StoredLayoutSettings): void {
  if (!settings || typeof settings !== 'object' || !isLayoutMode(settings.mode)) {
    throw new Error('无效的布局设置');
  }
  store.put('settings', 'layout', { mode: settings.mode });
}

/** Window chrome color applied before the renderer paints; avoids a theme flash. */
export function windowBackgroundColor(store: SqliteStore | undefined, systemPrefersLight: boolean): string {
  const mode = store ? appearanceSettings(store).mode : 'system';
  const light = mode === 'light' || (mode === 'system' && systemPrefersLight);
  return light ? '#f6f6f7' : '#16171a';
}
