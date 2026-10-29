/* global window, document, structuredClone */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Isolated renderer fixture: no real model, SSH connection or credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const output = path.join(root, '.cache/ai-panel-smoke');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(root, 'Tests/smoke/ui-fixture'), configFile: false, cacheDir: path.join(root, '.cache/ai-panel-vite'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, esbuild: { jsx: 'automatic' },
  resolve: { alias: { react: path.dirname(requireDesktop.resolve('react/package.json')), 'react-dom': path.dirname(requireDesktop.resolve('react-dom/package.json')) } }
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL ? { channel: process.env.CLOUDHELM_SMOKE_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const errors = [];
  const longModelLabel = 'GPT-5.4 · 超长的自定义模型显示名称，用于验证窄侧栏布局';
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  const panel = page.getByRole('region', { name: 'AI 助手面板', exact: true });
  const input = page.getByRole('textbox', { name: '给 AI 的消息', exact: true });
  await input.waitFor();
  await page.getByRole('button', { name: /生产服务器 ubuntu@/ }).click();
  await panel.getByRole('button', { name: '检查这台服务器的磁盘占用', exact: true }).click();
  assert.equal(await input.textContent(), '检查这台服务器的磁盘占用');
  assert.equal(await page.evaluate(() => window.fixture.calls.some((call) => call.kind === 'start')), false, 'Suggestions fill a draft, never send it');
  const composerMetrics = await input.evaluate((element) => {
    const css = window.getComputedStyle(element);
    const send = element.closest('form').querySelector('[aria-label="发送消息"]').getBoundingClientRect();
    return { minHeight: css.minHeight, fontSize: css.fontSize, lineHeight: css.lineHeight, sendWidth: send.width, sendHeight: send.height };
  });
  assert.deepEqual(composerMetrics, { minHeight: '72px', fontSize: '13px', lineHeight: '20px', sendWidth: 24, sendHeight: 24 });
  const permissionTrigger = panel.getByRole('button', { name: /^权限选择，当前/u });
  assert.equal(await permissionTrigger.count(), 1, 'There is only one permission picker');
  assert.equal(await permissionTrigger.evaluate((element) => !!element.closest('[class*="composerTools"]')), true);
  assert.equal(await permissionTrigger.isDisabled(), true, 'A draft inherits the backend host default');
  assert.equal(await panel.getByText('Agent', { exact: true }).count(), 0, 'The static Agent label was removed');
  await page.screenshot({ path: path.join(output, 'welcome-dark.png') });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await panel.getByText('正在处理', { exact: true }).waitFor();
  const initialDefault = await page.evaluate(async () => (await window.cloudhelm.snapshot()).hosts.find((host) => host.id === 'prod').defaultMode);
  for (const [label, mode] of [['重要操作询问', 'ask'], ['完全访问', 'permissive'], ['AI 审核', 'ai-review'], ['重要操作询问', 'ask']]) {
    await permissionTrigger.click();
    const menu = page.getByRole('menu', { name: '权限选择', exact: true });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem').count(), 3, 'Only implemented permission modes are offered');
    await menu.getByRole('menuitem', { name: new RegExp(`^${label}`, 'u') }).click();
    await panel.getByRole('button', { name: `权限选择，当前 ${label}`, exact: true }).waitFor();
    const routed = await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'review-mode').at(-1));
    const taskId = await page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations[0].id);
    assert.deepEqual({ taskId: routed.taskId, hostId: routed.hostId, mode: routed.mode }, { taskId, hostId: 'prod', mode });
    // Allow the ordinary color transition to settle; this is not an execution state.
    if (mode === 'permissive') await page.waitForFunction(() => window.getComputedStyle(document.querySelector('button[aria-label="权限选择，当前 完全访问"]')).color === 'rgb(245, 161, 75)');
  }
  assert.equal(await page.evaluate(async () => (await window.cloudhelm.snapshot()).hosts.find((host) => host.id === 'prod').defaultMode), initialDefault, 'Conversation switching must not rewrite the host default');
  await permissionTrigger.click();
  await page.getByRole('menu', { name: '权限选择', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'permission-menu-dark.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const snapshot = await window.cloudhelm.snapshot();
    const task = snapshot.conversations[0];
    const at = Date.now();
    task.plan = [{ id: 'p1', title: '读取服务配置', status: 'done' }, { id: 'p2', title: '核对磁盘与服务状态', status: 'running' }, { id: 'p3', title: '汇总检查结果', status: 'pending' }];
    snapshot.messages = [{ taskId: task.id, role: 'user', text: '检查磁盘并确认服务是否正常。', createdAt: at - 100 },
      { taskId: task.id, role: 'agent', entryId: 'intro', text: '我会先核对当前环境，再结合命令结果给出建议。', createdAt: at - 90 }];
    snapshot.operations = [{ id: 'disk', taskId: task.id, hostId: 'prod', kind: 'command', preview: 'df -h', status: 'succeeded', outputTail: '/dev/sda1 145G 54G 92G 37% /', exitCode: 0, createdAt: at - 80 },
      { id: 'uncertain', taskId: task.id, hostId: 'prod', kind: 'command', preview: 'systemctl status example.service', status: 'unknown', createdAt: at - 70 }];
    snapshot.reasoningProgress = { [task.id]: { id: 'thinking', createdAt: at - 4000, model: { provider: 'openai', modelId: 'gpt-5.4' },
      reasoning: { kind: 'thinking', status: 'streaming', text: '先区分磁盘容量与服务健康，避免把命令退出码当成最终结论。' } } };
    window.fixture.aiPanelSnapshot = snapshot;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const thinking = panel.getByRole('region', { name: '思考内容', exact: true });
  const thinkingToggle = thinking.getByRole('button');
  await thinkingToggle.waitFor();
  assert.equal(await thinkingToggle.getAttribute('aria-expanded'), 'false');
  await thinkingToggle.click();
  await thinking.getByText('先区分磁盘容量与服务健康，避免把命令退出码当成最终结论。', { exact: true }).waitFor();
  const thinkingMetrics = await thinkingToggle.evaluate((element) => {
    const css = window.getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, fontSize: css.fontSize, gap: css.gap, radius: css.borderRadius };
  });
  assert.deepEqual(thinkingMetrics, { height: 20, fontSize: '11px', gap: '4px', radius: '4px' });
  const reasoningId = await thinkingToggle.getAttribute('aria-controls');
  const reasoningBody = thinking.locator(`[id="${reasoningId}"]`);
  assert.equal(await reasoningBody.evaluate((element) => window.getComputedStyle(element).maxHeight), '180px');
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot;
    snapshot.reasoningProgress[snapshot.conversations[0].id].reasoning.text += '\n随后核对监听端口与健康检查。';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  await thinking.getByText(/随后核对监听端口与健康检查/u).waitFor();
  await thinking.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(output, 'thinking-flow-dark.png') });
  assert.equal(await thinkingToggle.getAttribute('aria-expanded'), 'true', 'Stream deltas must preserve the fold state');
  await thinkingToggle.click();
  assert.equal(await thinking.getByText(/随后核对监听端口与健康检查/u).count(), 0);
  await thinking.locator('summary').click();
  assert.equal(await thinkingToggle.isVisible(), false, 'The entire thinking process can also be folded');
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot;
    snapshot.reasoningProgress[snapshot.conversations[0].id].reasoning.text += '\n新的增量不会重新打开已收起的思考组。';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  assert.equal(await thinkingToggle.isVisible(), false, 'Stream deltas must not reopen the folded group');
  await thinking.locator('summary').click();
  const plan = panel.getByRole('region', { name: '执行计划', exact: true });
  await plan.getByRole('button').click();
  await plan.getByText('汇总检查结果', { exact: true }).waitFor();
  assert.match(await plan.innerText(), /1\/3/u);
  assert.equal(await plan.evaluate((element) => !!element.closest('form')), true, 'The plan and editor share one composer surface');
  await plan.getByRole('button').press('Enter');
  assert.equal(await plan.getByRole('button').getAttribute('aria-expanded'), 'false');
  assert.equal(await plan.getByText('汇总检查结果', { exact: true }).isVisible(), false);
  const success = panel.locator('details').filter({ has: page.locator('summary', { hasText: '已完成远端命令' }) }).first();
  assert.equal(await success.getAttribute('open'), null);
  await success.locator(':scope > summary').click();
  await success.getByText('/dev/sda1 145G 54G 92G 37% /', { exact: true }).waitFor();
  await success.locator(':scope > summary').click();
  await panel.getByText('结果待核验', { exact: true }).waitFor();
  await panel.getByText('systemctl status example.service', { exact: true }).first().waitFor();
  await page.evaluate(async (label) => {
    const models = await window.cloudhelm.availableModels();
    models[0].name = label;
    window.cloudhelm.availableModels = async () => models;
    const snapshot = window.fixture.aiPanelSnapshot;
    snapshot.profile.hasKey = !snapshot.profile.hasKey;
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  }, longModelLabel);
  await panel.getByRole('button', { name: `对话模型，当前 ${longModelLabel}`, exact: true }).waitFor();
  const resizer = page.getByRole('separator', { name: '调整 AI 助手宽度' });
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [330, 620]) {
      await resizer.focus();
      for (let i = 0; i < 16; i++) await resizer.press(width === 330 ? 'ArrowRight' : 'ArrowLeft');
      const layout = await page.evaluate(() => {
        const editor = document.querySelector('[role=textbox][aria-label="给 AI 的消息"]').getBoundingClientRect();
        const form = document.querySelector('[role=textbox][aria-label="给 AI 的消息"]').closest('form');
        const toolbar = form.querySelector('[class*="composerTools"]');
        const formBounds = form.getBoundingClientRect();
        const controlsFit = [...toolbar.querySelectorAll('button')].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= formBounds.left && rect.right <= formBounds.right;
        });
        const permission = document.querySelector('button[aria-label^="权限选择"]');
        const permissionAligned = permission.querySelector('svg').getBoundingClientRect().left - permission.getBoundingClientRect().left < 8;
        const add = toolbar.querySelector('button[aria-label="添加本地资料"]').getBoundingClientRect();
        const addBeforeMode = add.right <= permission.getBoundingClientRect().left;
        return { overflow: document.documentElement.scrollWidth > window.innerWidth, visible: editor.top >= 0 && editor.bottom <= window.innerHeight,
          controlsFit, permissionAligned, addBeforeMode, toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth + 1 };
      });
      assert.deepEqual(layout, { overflow: false, visible: true, controlsFit: true, permissionAligned: true, addBeforeMode: true, toolbarOverflow: false });
      await page.screenshot({ path: path.join(output, `panel-${theme}-${width}.png`) });
      if (theme === 'light' && width === 330) {
        await permissionTrigger.click();
        await page.getByRole('menu', { name: '权限选择', exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, 'permission-menu-light-330.png') });
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const compactLayout = await input.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { visible: bounds.top >= 0 && bounds.bottom <= window.innerHeight, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  assert.deepEqual(compactLayout, { visible: true, overflow: false });
  await page.screenshot({ path: path.join(output, 'panel-cn-short-light.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  // A long response must not drag the reader back down when new tokens arrive.
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot;
    snapshot.messages[1].text = '逐项核对服务器状态。\n\n'.repeat(150);
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  const scroll = panel.locator('[class*="agentScroll"]');
  await scroll.evaluate((element) => element.scrollTo(0, 0));
  await panel.getByRole('button', { name: '回到最新', exact: true }).waitFor();
  await page.evaluate(() => {
    const snapshot = window.fixture.aiPanelSnapshot;
    snapshot.messages[1].text += '\n新的检查结果。';
    window.fixture.inject({ type: 'snapshot', value: structuredClone(snapshot) });
  });
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  await panel.getByRole('button', { name: '回到最新', exact: true }).click();
  assert.ok(await scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 48));
  await panel.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.getByRole('menu', { name: '历史对话', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(`AI panel smoke passed. Screenshots: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
