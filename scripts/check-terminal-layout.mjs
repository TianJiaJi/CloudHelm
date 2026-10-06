/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';

export async function checkTerminalLayout(page, screenshot) {
  const originalViewport = page.viewportSize();
  for (const agent of [false, true]) {
    await page.getByRole('button', { name: agent ? '打开 AI 专用终端' : '生产服务器', exact: true }).click();
    for (const viewport of [{ width: 1440, height: 820 }, { width: 980, height: 640 }, { width: 1440, height: 1100 }]) {
      await page.setViewportSize(viewport);
      // ResizeObserver + xterm's render frame settle after setViewportSize returns.
      await page.waitForFunction(() => {
        const holder = document.querySelector('[aria-label="SSH terminal"]');
        const screen = holder?.querySelector('.xterm-screen');
        if (!holder || !screen) return false;
        const bounds = holder.getBoundingClientRect();
        const grid = screen.getBoundingClientRect();
        const padding = getComputedStyle(holder);
        const resize = window.fixture.calls.filter((call) => call.kind === 'resize').at(-1);
        return resize && grid.bottom <= bounds.bottom - parseFloat(padding.paddingBottom) + 1
          && grid.right <= bounds.right - parseFloat(padding.paddingRight) + 1
          && Math.abs(grid.bottom - (bounds.bottom - parseFloat(padding.paddingBottom))) < 24
          && resize.rows === holder.querySelector('.xterm-rows')?.children.length;
      });
      await page.evaluate(() => {
        const resize = window.fixture.calls.filter((call) => call.kind === 'resize').at(-1);
        window.fixture.inject({ type: 'terminal-data', terminalId: resize.id,
          data: `\u001b[2J\u001b[H${Array.from({ length: 250 }, (_, index) => `output line ${index}\r\n`).join('')}CLOUDHELM_LAST_PROMPT> ` });
      });
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('CLOUDHELM_LAST_PROMPT>'));
      const dimensions = await page.locator('[aria-label="SSH terminal"]').evaluate((holder) => {
        const bounds = holder.getBoundingClientRect();
        const padding = getComputedStyle(holder);
        const screen = holder.querySelector('.xterm-screen').getBoundingClientRect();
        const row = [...holder.querySelectorAll('.xterm-rows > div')].find((element) => element.textContent.includes('CLOUDHELM_LAST_PROMPT>'));
        const prompt = row.getBoundingClientRect();
        return { bottom: bounds.bottom - parseFloat(padding.paddingBottom), right: bounds.right - parseFloat(padding.paddingRight),
          screenBottom: screen.bottom, screenRight: screen.right, promptBottom: prompt.bottom,
          rows: holder.querySelector('.xterm-rows').children.length,
          resize: window.fixture.calls.filter((call) => call.kind === 'resize').at(-1),
          hit: holder.contains(document.elementFromPoint(prompt.x + 8, prompt.bottom - 2)) };
      });
      assert.ok(dimensions.screenBottom <= dimensions.bottom + 1, `Terminal screen must fit above the bottom padding: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.screenRight <= dimensions.right + 1, 'Terminal columns must fit inside the right padding');
      assert.ok(dimensions.promptBottom <= dimensions.bottom + 1 && dimensions.hit, 'The final prompt must be fully visible and hit-testable');
      assert.equal(dimensions.resize.rows, dimensions.rows, 'SSH PTY receives the rendered row count');
    }
    await screenshot(agent ? 'terminal-agent-last-line.png' : 'terminal-human-last-line.png');
  }
  await page.setViewportSize(originalViewport);
  await page.getByRole('button', { name: '生产服务器', exact: true }).click();
}
