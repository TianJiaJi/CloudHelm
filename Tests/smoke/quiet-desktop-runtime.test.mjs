import { afterEach, describe, expect, it, vi } from 'vitest';
import { installQuietStartupGuards } from './quiet-desktop-runtime.mjs';

function fixture(mode = 'cloudhelm-quiet-desktop-v1') {
  const events = new Map(), failures = new Map();
  const app = { on: (key, fn) => events.set(key, fn), exit: vi.fn() };
  const dialog = { showErrorBox: vi.fn() };
  const runtime = { env: { CLOUDHELM_TEST_WINDOW: mode }, stderr: { write: vi.fn() }, on: (key, fn) => failures.set(key, fn) };
  installQuietStartupGuards({ app, dialog }, runtime);
  return { app, dialog, runtime, events, failures };
}
afterEach(() => { delete globalThis.__cloudhelmQuietDesktop; });
describe('quiet startup failure guards without native windows', () => {
  it('rejects a missing protocol without registering a window handler', () => {
    const f = fixture(''); expect(f.app.exit).toHaveBeenCalledWith(1); expect(f.events.size).toBe(0);
  });
  it('turns early exceptions, rejected imports and error boxes into a bounded non-GUI failure', () => {
    const f = fixture();
    f.failures.get('uncaughtException')(new Error('synthetic private detail'));
    f.failures.get('unhandledRejection')(new Error('synthetic private detail'));
    f.dialog.showErrorBox('synthetic private detail');
    expect(f.app.exit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(f.runtime.stderr.write.mock.calls)).not.toContain('synthetic private detail');
  });
  it('records every window and rejects visibility/focus transitions without weakening assertions', () => {
    const f = fixture(), events = new Map();
    const window = { isVisible: () => false, isFocused: () => false, isFocusable: () => false,
      on: (key, fn) => events.set(key, fn), webContents: { setWindowOpenHandler: vi.fn() } };
    f.events.get('browser-window-created')({}, window);
    expect(f.app.exit).not.toHaveBeenCalled();
    expect(globalThis.__cloudhelmQuietDesktop.windowsCreated).toBe(1);
    expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    for (const event of ['show', 'focus', 'maximize', 'enter-full-screen']) events.get(event)();
    expect(f.app.exit).toHaveBeenCalledTimes(4);
    expect(globalThis.__cloudhelmQuietDesktop.violations).toEqual(['show', 'focus', 'maximize', 'enter-full-screen']);
  });
});
