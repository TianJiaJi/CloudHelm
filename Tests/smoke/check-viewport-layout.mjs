/* global window, document, structuredClone */
import assert from 'node:assert/strict';

export async function checkViewportLayout(page, screenshot) {
  const originalViewport = page.viewportSize();
  await page.evaluate(async () => {
    const original = await window.cloudhelm.snapshot();
    window.fixture.beforeLayout = original;
    const snapshot = structuredClone(original);
    const taskId = snapshot.conversations[0].id;
    snapshot.conversations[0].plan = [];
    snapshot.approvals = [];
    snapshot.messages.push({ taskId, role: 'agent', createdAt: Date.now(), text:
      `${'磁盘检查结果：根分区空间充足。\n\n'.repeat(60)}\n\`\`\`bash\ndf -hT\n\`\`\`\n检查完成。` });
    window.fixture.inject({ type: 'snapshot', value: snapshot });
  });
  await page.getByRole('button', { name: '复制代码', exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 820 }, { width: 980, height: 640 }, originalViewport]) {
    await page.setViewportSize(viewport);
    const scroll = page.locator('[class*="agentScroll"]');
    await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth - window.innerWidth,
      height: document.documentElement.scrollHeight - window.innerHeight
    }));
    assert.deepEqual(overflow, { width: 0, height: 0 }, 'Long replies with code blocks must not enlarge the document');
    assert.ok(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight), 'Long replies remain scrollable inside the assistant');
    await page.getByRole('button', { name: '打开 AI 专用终端', exact: true }).click();
    await page.getByRole('textbox', { name: '给 AI 的消息' }).focus();
    const geometry = await page.evaluate(() => {
      const bounds = document.querySelector('#root > div').getBoundingClientRect();
      const composer = document.querySelector('[role="textbox"][aria-label="给 AI 的消息"]').getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, scrollY: window.scrollY,
        composerVisible: composer.top >= 0 && composer.bottom <= window.innerHeight };
    });
    assert.deepEqual(geometry, { top: 0, bottom: viewport.height, scrollY: 0, composerVisible: true }, 'Opening the AI terminal and focusing input must keep the shell in the viewport');
  }
  await screenshot('viewport-long-reply.png');
  await page.evaluate(() => window.fixture.inject({ type: 'snapshot', value: window.fixture.beforeLayout }));
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
}
