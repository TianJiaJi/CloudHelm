/* global window */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { quietElectron, QUIET_DESKTOP_PROTOCOL } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-quiet-desktop-'));
const instances = new Set();
try {
  const application = await quietElectron.launch({ executablePath: createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: { ...process.env, CLOUDHELM_USER_DATA: userData }, timeout: 30_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  const page = await application.firstWindow({ timeout: 30_000 });
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  const state = () => application.evaluate(({ BrowserWindow }) => ({
    evidence: globalThis.__cloudhelmQuietDesktop,
    windows: BrowserWindow.getAllWindows().map((item) => ({ visible: item.isVisible(), focused: item.isFocused(), focusable: item.isFocusable(),
      fullscreenable: item.isFullScreenable(), maximizable: item.isMaximizable(), offscreen: item.webContents.isOffscreen() }))
  }));
  const expected = { evidence: { protocol: QUIET_DESKTOP_PROTOCOL, windowsCreated: 1, violations: [] },
    windows: [{ visible: false, focused: false, focusable: false, fullscreenable: false, maximizable: false, offscreen: false }] };
  assert.deepEqual(await state(), expected);
  // Real preload/IPC, no chooser stubs: defaults must cancel rather than open native UI.
  assert.deepEqual(await withTimeout(() => page.evaluate(async () => [
    await window.cloudhelm.selectPrivateKey(), await window.cloudhelm.selectLocalPath('file'),
    await window.cloudhelm.selectLocalPath('directory')
  ]), 10_000, 'Quiet native pickers'), [null, null, null]);
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('Synthetic quiet UI input, never sent');
  await application.evaluate(({ app }) => app.emit('second-instance', {}, [], '', {}));
  const output = path.join(root, '.cache/quiet-desktop-smoke'); await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'hidden-window.png'), timeout: 15_000 });
  assert.deepEqual(await state(), expected);
  await owner.close(); instances.delete(owner);
  console.log(JSON.stringify({ check: 'quiet-desktop-smoke', hidden: true, focusable: false, nativeWindowEvents: 0,
    unstubbedPickersCanceled: true, secondInstanceDidNotActivate: true, screenshotRendered: true,
    paidModelRequests: 0, virtualMachineConnections: 0 }));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => { console.warn(message); process.exitCode = 1; });
}
