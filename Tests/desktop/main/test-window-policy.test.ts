import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { applicationTestWindowPolicy, QUIET_DESKTOP_PROTOCOL, silenceTestDialogs, testWindowPolicy } from '../../../apps/desktop/src/main/test-window-policy.js';

const normal = resolve('synthetic-normal-profile');
const profile = resolve('synthetic-isolated-profile');

describe('quiet desktop window policy', () => {
  it('leaves normal launches and ordinary custom profiles unchanged', () => {
    expect(testWindowPolicy({}, normal)).toEqual({ hidden: false, options: {} });
    expect(testWindowPolicy({ CLOUDHELM_USER_DATA: profile }, normal)).toEqual({ hidden: false, options: {} });
  });
  it('disables visibility and focus at construction, without replacing renderer isolation options', () => {
    const policy = testWindowPolicy({ CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL, CLOUDHELM_USER_DATA: profile }, normal);
    expect(policy).toEqual({ hidden: true, options: { show: false, focusable: false, skipTaskbar: true,
      fullscreenable: false, maximizable: false, minimizable: false, paintWhenInitiallyHidden: true } });
    expect(policy.options.webPreferences).toBeUndefined();
  });
  it('rejects an invalid mode, missing profile, relative profile or normal profile', () => {
    for (const mode of ['', 'hidden', 'interactive', 'typo']) {
      expect(() => testWindowPolicy({ CLOUDHELM_TEST_WINDOW: mode, CLOUDHELM_USER_DATA: profile }, normal)).toThrow();
    }
    for (const value of [undefined, '', 'relative-profile', normal]) {
      expect(() => testWindowPolicy({ CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL, CLOUDHELM_USER_DATA: value }, normal)).toThrow();
    }
  });
  it('does not mistake an already configured test directory for the default user profile', () => {
    const appData = resolve('synthetic-app-data');
    const app = { getPath: vi.fn((name: string) => name === 'appData' ? appData : profile), getName: () => 'SyntheticApp' };
    expect(applicationTestWindowPolicy({ CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL, CLOUDHELM_USER_DATA: profile }, app).hidden).toBe(true);
    expect(app.getPath).toHaveBeenCalledExactlyOnceWith('appData');
    expect(() => applicationTestWindowPolicy({ CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL,
      CLOUDHELM_USER_DATA: resolve(appData, app.getName()) }, app)).toThrow('separate');
  });
  it('cancels native pickers and explicit cancel buttons, never silently approves a confirmation', async () => {
    const dialog = { showOpenDialog: vi.fn(), showOpenDialogSync: vi.fn(), showSaveDialog: vi.fn(), showSaveDialogSync: vi.fn(),
      showMessageBox: vi.fn(), showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() };
    silenceTestDialogs(dialog);
    expect(await dialog.showOpenDialog()).toEqual({ canceled: true, filePaths: [] });
    expect(dialog.showOpenDialogSync()).toBeUndefined();
    expect(await dialog.showSaveDialog()).toEqual({ canceled: true, filePath: '' });
    expect(dialog.showSaveDialogSync()).toBe('');
    expect(await dialog.showMessageBox({ buttons: ['Stay', 'Exit'], cancelId: 0 })).toEqual({ response: 0, checkboxChecked: false });
    expect(dialog.showMessageBoxSync({ buttons: ['Yes', 'No'], cancelId: 1 })).toBe(1);
    await expect(dialog.showMessageBox({ buttons: ['Approve'] })).rejects.toThrow('explicit cancellation');
    expect(() => dialog.showMessageBoxSync({ buttons: ['Approve'], cancelId: 2 })).toThrow();
    expect(() => dialog.showErrorBox()).toThrow('forbidden');
  });
});
