import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureHiddenWindow, captureQuietDesktop, quietCaptureLayout } from './quiet-screenshot.mjs';
import { QUIET_DESKTOP_PROTOCOL } from './quiet-electron.mjs';

const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function fixture() {
  vi.stubGlobal('__cloudhelmQuietDesktop', { protocol: QUIET_DESKTOP_PROTOCOL, violations: [] });
  const bitmap = Buffer.alloc(8); bitmap.writeUInt32LE(0xffffffff, 4);
  const image = { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toBitmap: () => bitmap, toPNG: () => Buffer.from('synthetic-image') };
  const target = { isDestroyed: () => false, isVisible: () => false, isFocused: () => false, isFocusable: () => false,
    webContents: { isDestroyed: () => false, capturePage: vi.fn(async () => image) } };
  return { target, image, bitmap };
}
async function destination() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-quiet-image-')); directories.push(directory);
  return path.join(directory, 'window.png');
}
it('uses stayHidden without waking the system and preserves nonempty rendered output', async () => {
  const { target } = fixture();
  expect(await captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).toMatchObject({ size: { width: 2, height: 1 } });
  expect(target.webContents.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true, stayAwake: false });
});
it.each(['isVisible', 'isFocused', 'isFocusable'])('rejects %s without taking a screenshot', async (property) => {
  const { target } = fixture(); target[property] = () => true;
  await expect(captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).rejects.toThrow('hidden, non-focusable');
  expect(target.webContents.capturePage).not.toHaveBeenCalled();
});
it('rejects missing protocol and violations observed during capture', async () => {
  const { target, image } = fixture(); vi.stubGlobal('__cloudhelmQuietDesktop', undefined);
  await expect(captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).rejects.toThrow();
  expect(target.webContents.capturePage).not.toHaveBeenCalled();
  vi.stubGlobal('__cloudhelmQuietDesktop', { protocol: QUIET_DESKTOP_PROTOCOL, violations: [] });
  target.webContents.capturePage.mockImplementationOnce(async () => { globalThis.__cloudhelmQuietDesktop.violations.push('focus'); return image; });
  await expect(captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).rejects.toThrow();
});
it('rejects empty or uniform images instead of calling blank output rendered', async () => {
  const { target, image, bitmap } = fixture(); image.isEmpty = () => true;
  await expect(captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).rejects.toThrow('is empty');
  image.isEmpty = () => false; bitmap.fill(0);
  await expect(captureHiddenWindow(target, QUIET_DESKTOP_PROTOCOL)).rejects.toThrow('pixel variation');
});
it('measures body and root overflow as well as the viewport', async () => {
  const dimensions = { scrollWidth: 100, offsetWidth: 100, clientWidth: 100, scrollHeight: 60, offsetHeight: 60, clientHeight: 60 };
  vi.stubGlobal('window', { innerWidth: 100, innerHeight: 60 });
  vi.stubGlobal('document', { fonts: { ready: Promise.resolve() }, body: { ...dimensions, offsetHeight: 80 }, documentElement: dimensions });
  expect(await quietCaptureLayout()).toEqual({ width: 100, height: 60, fullWidth: 100, fullHeight: 80 });
});
it('binds the exact page, rejects cropping before capture and disposes the native handle', async () => {
  const { target } = fixture(), output = await destination();
  const page = { evaluate: vi.fn(async () => ({ width: 2, height: 1, fullWidth: 2, fullHeight: 2 })) };
  const handle = { evaluate: (callback, argument) => callback(target, argument), dispose: vi.fn(async () => {}) };
  const application = { browserWindow: vi.fn(async () => handle) };
  await expect(captureQuietDesktop(application, page, output)).rejects.toThrow('crop');
  expect(application.browserWindow).not.toHaveBeenCalled();
  page.evaluate.mockResolvedValue({ width: 2, height: 1, fullWidth: 2, fullHeight: 1 });
  await captureQuietDesktop(application, page, output);
  expect(application.browserWindow).toHaveBeenCalledWith(page); expect(handle.dispose).toHaveBeenCalledOnce();
  expect(await readFile(output, 'utf8')).toBe('synthetic-image');
});
it('fails a hung capture within its deadline and does not write a late result', async () => {
  const output = await destination(); let complete, disposed;
  const finished = new Promise((resolve) => { disposed = resolve; });
  const handle = { evaluate: () => new Promise((resolve) => { complete = resolve; }), dispose: async () => disposed() };
  const page = { evaluate: async () => ({ width: 2, height: 1, fullWidth: 2, fullHeight: 1 }) };
  await expect(captureQuietDesktop({ browserWindow: async () => handle }, page, output, { timeoutMs: 20 })).rejects.toThrow('timed out');
  complete({ size: { width: 2, height: 1 }, png: Buffer.from('late').toString('base64') }); await finished;
  expect(await access(output).then(() => true, () => false)).toBe(false);
});
