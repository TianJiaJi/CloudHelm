import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../../../apps/desktop/src/renderer/store.js';

const saveLayoutSettings = vi.fn(async (): Promise<void> => {});

beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
  saveLayoutSettings.mockClear();
  vi.stubGlobal('window', { cloudhelm: { saveLayoutSettings } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('layout mode state', () => {
  it('boots into the SSH layout by default', () => {
    expect(useUi.getState().layoutMode).toBe('ssh');
  });
  it('switches the layout and persists the choice', () => {
    useUi.getState().setLayoutMode('agent');
    expect(useUi.getState().layoutMode).toBe('agent');
    expect(saveLayoutSettings).toHaveBeenCalledWith({ mode: 'agent' });
  });
  it('keeps the switched layout when persistence fails', () => {
    saveLayoutSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    useUi.getState().setLayoutMode('agent');
    expect(useUi.getState().layoutMode).toBe('agent');
  });
  it('toggles the terminal drawer', () => {
    expect(useUi.getState().drawerOpen).toBe(true);
    useUi.getState().toggleDrawer();
    expect(useUi.getState().drawerOpen).toBe(false);
    useUi.getState().toggleDrawer();
    expect(useUi.getState().drawerOpen).toBe(true);
  });
  it('clamps the drawer height to a usable minimum', () => {
    useUi.getState().setDrawerHeight(40);
    expect(useUi.getState().drawerHeight).toBe(150);
    useUi.getState().setDrawerHeight(320);
    expect(useUi.getState().drawerHeight).toBe(320);
  });
  it('clamps the aux panel width into its usable range', () => {
    useUi.getState().setAuxPanelWidth(200);
    expect(useUi.getState().auxPanelWidth).toBe(360);
    useUi.getState().setAuxPanelWidth(900);
    expect(useUi.getState().auxPanelWidth).toBe(620);
    useUi.getState().setAuxPanelWidth(500);
    expect(useUi.getState().auxPanelWidth).toBe(500);
  });
});
