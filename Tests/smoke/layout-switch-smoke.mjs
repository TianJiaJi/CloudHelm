/* Layout switch roundtrip, agent-mode shortcuts, reload restore and the appearance section. Fake fixture only. */
/* global window, document */
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
const output = path.join(root, '.cache/layout-switch-smoke');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(root, 'Tests/smoke/ui-fixture'), configFile: false, cacheDir: path.join(root, '.cache/ui-smoke-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: {
    react: path.dirname(desktopRequire.resolve('react/package.json')),
    'react-dom': path.dirname(desktopRequire.resolve('react-dom/package.json'))
  } }
});
await server.listen();
let browser;
let page;
const screenshot = (name) => page.screenshot({ path: path.join(output, name) });
const lastCall = (kind) => page.evaluate((callKind) => window.fixture.calls.filter((call) => call.kind === callKind).at(-1), kind);
const sameSpot = (a, b) => Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;

try {
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark',
    deviceScaleFactor: Number(process.env.CLOUDHELM_SMOKE_DEVICE_SCALE_FACTOR ?? 1) });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  const switcher = page.getByLabel('界面布局模式');

  // Fresh start lands on the SSH layout; the drawer and its shortcut stay inert here.
  await page.getByText('远程主机').waitFor();
  assert.equal(await page.locator('section[aria-label="终端抽屉"]').count(), 0, 'SSH 模式不应渲染终端抽屉');
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('section[aria-label="终端抽屉"]').count(), 0, 'Ctrl+J 在 SSH 模式必须被布局守卫拦下');
  const sshSpot = await switcher.boundingBox();

  // Create state worth preserving: a selected conversation in the history list.
  await page.getByRole('textbox', { name: '给 AI 的消息' }).fill('梳理磁盘占用');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.locator('button[class*="historyRow"][class*="selected"]', { hasText: '梳理磁盘占用' }).waitFor();

  // Switching to Agent renders the host tree, persists the mode and keeps the
  // switcher at identical coordinates; selection survives the switch.
  await switcher.getByText('Agent', { exact: true }).click();
  await page.locator('aside[aria-label="主机与对话树"]').waitFor();
  assert.equal((await lastCall('layout')).settings.mode, 'agent', '切换布局必须持久化为 agent');
  assert.ok(sameSpot(await switcher.boundingBox(), sshSpot), '布局开关在两种布局下必须处于同一坐标');
  await page.locator('span[class*="crumb"] strong', { hasText: '梳理磁盘占用' }).waitFor();
  // Agent-mode defaults: the terminal drawer starts retracted and hosts in the
  // tree start collapsed.
  assert.equal(await page.locator('section[aria-label="终端抽屉"]').count(), 0, 'Agent 模式的终端抽屉应默认收起');
  await page.getByRole('button', { name: '展开 生产服务器' }).waitFor();

  // Agent-mode shortcuts: Ctrl+J toggles the drawer, Ctrl+K focuses the tree
  // search, Ctrl+N starts a new conversation.
  await page.keyboard.press('Control+j');
  await page.locator('section[aria-label="终端抽屉"]').waitFor();
  // The center column must carry the assistant panel surface so panel-scoped
  // rules (floating 回到最新 pill, suggestion and plan-toggle styling) apply.
  await page.locator('div[class*="stream"][class*="panel"]').first().waitFor();
  await page.keyboard.press('Control+j');
  await page.locator('section[aria-label="终端抽屉"]').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+k');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '搜索主机与对话', 'Ctrl+K 应聚焦主机树搜索框');
  await page.keyboard.press('Control+n');
  await page.locator('span[class*="crumb"] strong', { hasText: '新对话' }).waitFor();

  // Round-trip back to SSH: the conversation survives and the switcher holds still.
  await switcher.getByText('SSH', { exact: true }).click();
  await page.getByText('远程主机').waitFor();
  await page.locator('button[class*="historyRow"]', { hasText: '梳理磁盘占用' }).waitFor();
  assert.ok(sameSpot(await switcher.boundingBox(), sshSpot), '往返后布局开关坐标必须保持不变');

  // A reload after switching to Agent restores the layout through the same
  // persisted chain the real preload provides (fixture: sessionStorage).
  await switcher.getByText('Agent', { exact: true }).click();
  await page.locator('aside[aria-label="主机与对话树"]').waitFor();
  await page.reload();
  await page.locator('aside[aria-label="主机与对话树"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.layout), 'agent', '重载后必须恢复 Agent 布局');
  await screenshot('agent-restored.png');

  // Settings appearance section: switching to light applies immediately and persists.
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '外观' }).click();
  await page.getByRole('radiogroup', { name: '外观模式' }).locator('button', { hasText: '固定使用浅色配色' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal((await lastCall('appearance')).settings.mode, 'light', '外观偏好必须持久化为 light');
  await screenshot('agent-appearance-light.png');
  await page.getByRole('button', { name: '返回终端' }).click();
  await page.locator('span[class*="crumb"] strong', { hasText: '新对话' }).waitFor();

  assert.deepEqual(errors, []);
  console.log(`Layout switch smoke passed. Fake fixture only; screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
