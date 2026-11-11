/* global document, window */
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { withTimeout } from './desktop-process.mjs';
import { QUIET_DESKTOP_PROTOCOL } from './quiet-electron.mjs';

/** Evaluated in the renderer. Refuse to silently crop a formerly full-page artifact. */
export async function quietCaptureLayout() {
  await document.fonts.ready;
  const body = document.body, root = document.documentElement;
  if (!body || !root) throw new Error('Quiet screenshot page is not ready');
  return { width: window.innerWidth, height: window.innerHeight,
    fullWidth: Math.max(body.scrollWidth, root.scrollWidth, body.offsetWidth, root.offsetWidth, body.clientWidth, root.clientWidth),
    fullHeight: Math.max(body.scrollHeight, root.scrollHeight, body.offsetHeight, root.offsetHeight, body.clientHeight, root.clientHeight) };
}

/** Serialized into Electron main via the handle for this exact Playwright page. */
export async function captureHiddenWindow(target, protocol) {
  const check = () => {
    const evidence = globalThis.__cloudhelmQuietDesktop;
    if (!evidence || evidence.protocol !== protocol || !Array.isArray(evidence.violations) || evidence.violations.length
      || target.isDestroyed() || target.webContents.isDestroyed() || target.isVisible() || target.isFocused() || target.isFocusable()) {
      throw new Error('Quiet screenshot requires an intact hidden, non-focusable test window');
    }
  };
  check();
  const image = await target.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false });
  check();
  const size = image.getSize();
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new Error('Quiet screenshot is empty');
  const bitmap = image.toBitmap();
  let varied = false;
  for (let offset = 4; offset + 4 <= bitmap.length; offset += 4) {
    if (bitmap.readUInt32LE(offset) !== bitmap.readUInt32LE(0)) { varied = true; break; }
  }
  if (!varied) throw new Error('Quiet screenshot has no rendered pixel variation');
  return { size, png: image.toPNG().toString('base64') };
}

/** Explicit native route, never a passing fallback after a failed screenshot. No show/focus/offscreen. */
export async function captureQuietDesktop(application, page, output, { timeoutMs = 30_000 } = {}) {
  let active = true;
  const assertActive = () => { if (!active) throw new Error('Quiet screenshot expired'); };
  try {
    return await withTimeout(async () => {
      const layout = await page.evaluate(quietCaptureLayout); assertActive();
      if (!Object.values(layout).every((value) => Number.isFinite(value) && value > 0)
        || layout.fullWidth > layout.width || layout.fullHeight > layout.height) {
        throw new Error('Quiet full-page screenshot would crop overflowing content');
      }
      const handle = await application.browserWindow(page);
      try {
        assertActive();
        const result = await handle.evaluate(captureHiddenWindow, QUIET_DESKTOP_PROTOCOL); assertActive();
        await writeFile(output, Buffer.from(result.png, 'base64'));
        return result.size;
      } finally { await handle.dispose(); }
    }, timeoutMs, 'Quiet desktop screenshot');
  } finally { active = false; }
}
