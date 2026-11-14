/* global window, document, navigator */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const server = await createServer({
  root: path.join(root, 'Tests/smoke/ui-fixture'), configFile: false, cacheDir: path.join(root, '.cache/reference-clipboard-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, esbuild: { jsx: 'automatic' },
  resolve: { alias: { react: path.dirname(desktopRequire.resolve('react/package.json')), 'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json')) } }
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(server.resolvedUrls.local[0]);
  const input = page.getByRole('textbox', { name: '给 AI 的消息', exact: true }); await input.waitFor();
  // Write our own synthetic marker before reading anything; never inspect the user's existing clipboard.
  await page.evaluate(() => navigator.clipboard.writeText('SYNTHETIC_CLIPBOARD_START'));
  await page.getByRole('button', { name: /生产服务器 ubuntu@/u }).click();
  await page.getByRole('button', { name: '引用输出', exact: true }).click();
  await input.getByRole('button', { name: 'Terminal', exact: true }).waitFor();
  await input.focus();
  await input.evaluate((element) => {
    const range = document.createRange(); range.selectNode(element.querySelector('[data-reference]'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.addEventListener('paste', (event) => {
      window.fixture.nativePaste = { custom: !!event.clipboardData.getData('application/x-cloudhelm-parts'), html: event.clipboardData.getData('text/html').includes('data-cloudhelm-reference-parts') };
    }, { once: true });
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('service:latest'));
  await input.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await page.waitForFunction(() => !!window.fixture.nativePaste);
  const preserved = await page.evaluate(() => window.fixture.nativePaste.custom || window.fixture.nativePaste.html);
  assert.equal(preserved, true, 'native copy/paste must preserve reference provenance, not silently downgrade it to plain input');
  await input.getByRole('button', { name: 'Terminal', exact: true }).nth(1).waitFor();
  assert.equal(await page.getByRole('button', { name: '丢弃草稿', exact: true }).count(), 0, 'composer no longer exposes the discard-draft button');
  console.log(JSON.stringify({ nativeClipboardProvenance: true, discardButtonRemoved: true, paidModelRequests: 0, virtualMachineConnections: 0 }));
} finally { await browser?.close(); await server.close(); }
