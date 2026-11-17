/* global window, navigator, document, getComputedStyle */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const output = path.join(root, '.cache/markdown-smoke');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(root, 'Tests/smoke/markdown-fixture'), configFile: false, cacheDir: path.join(root, '.cache/markdown-smoke-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, esbuild: { jsx: 'automatic' },
  resolve: { alias: { react: path.dirname(desktopRequire.resolve('react/package.json')), 'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json')) } }
});
await server.listen();
const codeBlock = (label, page) => page.locator('[class*="codeBlock"]').filter({ has: page.locator(`span:text-is("${label}")`) }).first();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 540, height: 1000 }, colorScheme: 'dark' });
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.url().includes('.example.test/')) remoteRequests.push(request.url()); });
  await page.route('**/*.example.test/**', (route) => route.abort());
  await page.addInitScript(() => {
    // Keep the user's real clipboard untouched while testing the copy button's exact payload.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.fixtureCopied = text; } } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('heading', { name: '部署结果总览' }).waitFor();
  assert.equal(await page.getByRole('table').count(), 1);
  assert.equal(await page.locator('blockquote').count(), 1);
  assert.equal(await page.locator('ul > li').count(), 6);
  assert.equal(await page.locator('ol > li').count(), 2);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.getByRole('link', { name: '不可执行链接' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '访问服务' }).getAttribute('href'), 'https://service.example.test/status');
  assert.equal(await page.getByRole('link', { name: '访问服务' }).getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.getByRole('link', { name: '查看图片：部署示意图' }).getAttribute('href'), 'https://images.example.test/private.png');

  // Syntax highlighting covers the bundled languages; unknown ones stay literal.
  const highlighted = [['yaml', '.hljs-attr'], ['bash', '.hljs-built_in'], ['json', '.hljs-attr'], ['ts', '.hljs-keyword'], ['diff', '.hljs-deletion']];
  for (const [label, token] of highlighted) {
    const block = codeBlock(label, page);
    assert.ok(await block.locator(token).count() > 0, `${label} block renders ${token} highlighting`);
    assert.equal(await block.locator('pre').evaluate((element) => getComputedStyle(element).fontSize), '12px', `${label} code stays at the 12px readability floor`);
  }
  for (const label of ['not-a-language', '代码']) {
    const block = codeBlock(label, page);
    assert.equal(await block.locator('[class*="hljs-"]').count(), 0, `${label} falls back to plain text`);
    assert.ok((await block.locator('pre').innerText()).length > 0, `${label} keeps the literal source`);
  }

  // Typography baseline: 13px/20px body, h4 no longer locked below the body size.
  const metrics = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('main p'));
    return { body: { size: style.fontSize, height: style.lineHeight },
      h4: getComputedStyle(document.querySelector('h4')).fontSize,
      table: getComputedStyle(document.querySelector('table')).fontSize };
  });
  assert.deepEqual(metrics.body, { size: '13px', height: '20px' }, 'assistant body text is 13px/20px');
  assert.equal(metrics.h4, '13px', 'h4 keeps the body font size');
  assert.equal(metrics.table, '12px', 'tables stay at the 12px readability floor');

  // Long blocks collapse by default and expand without losing content.
  const hundred = page.locator('[class*="codeBlock"]').filter({ hasText: 'step 001' }).first();
  const hundredPre = hundred.locator('pre');
  assert.equal(await hundredPre.evaluate((element) => getComputedStyle(element).maxHeight), '320px', '100-line code collapses by default');
  assert.ok(await hundredPre.evaluate((element) => element.scrollHeight > element.clientHeight), 'collapsed block actually overflows');
  assert.equal(await hundredPre.evaluate((element) => element.innerText.split('\n').length) >= 100, true, 'collapsed content stays complete');
  await hundred.getByRole('button', { name: '展开代码' }).click();
  assert.equal(await hundredPre.evaluate((element) => getComputedStyle(element).maxHeight), 'none', 'expand removes the height cap');
  await hundred.getByRole('button', { name: '收起代码' }).click();
  assert.equal(await hundredPre.evaluate((element) => getComputedStyle(element).maxHeight), '320px', 'collapse restores the cap');

  // On-demand wrapping keeps very long lines inside the panel without clipping.
  const longLineBlock = page.locator('[class*="codeBlock"]').filter({ hasText: 'a-very-long-single-line-path' }).first();
  const longLinePre = longLineBlock.locator('pre');
  const wrapToggle = longLineBlock.getByRole('button', { name: '切换换行' });
  assert.equal(await wrapToggle.getAttribute('aria-pressed'), 'false');
  assert.ok(await longLinePre.evaluate((element) => element.scrollWidth > element.clientWidth), 'the long line overflows before wrapping');
  await wrapToggle.click();
  assert.equal(await wrapToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await longLinePre.evaluate((element) => element.scrollWidth > element.clientWidth), false, 'wrapping keeps the line inside the block');

  // Copy delivers the exact fenced source, never rendered markup.
  const bashBlock = codeBlock('bash', page);
  await bashBlock.getByRole('button', { name: '复制代码' }).click();
  await bashBlock.getByRole('status').filter({ hasText: '代码已复制到剪贴板，不会执行。' }).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => window.fixtureCopied), 'echo "最近日志"\ndocker logs --tail 50 demo-service\n');
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.deepEqual(remoteRequests, []);
  await page.screenshot({ path: path.join(output, 'markdown-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.equal(await hundredPre.evaluate((element) => getComputedStyle(element).maxHeight), '320px', 'collapse state survives theme and width changes');
  await page.screenshot({ path: path.join(output, 'markdown-light.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Markdown smoke passed: highlighting, long-block reading, wrap/copy controls, safe GFM. Screenshots: ${output}`);
} finally { await browser?.close(); await server.close(); }
