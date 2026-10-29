/* global window, document */
import assert from 'node:assert/strict';
import path from 'node:path';

function luminance(color) {
  const channels = color.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `Expected an RGB color, received ${color}`);
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

async function assertReadable(button, state) {
  // Theme and hover transitions must settle before comparing rendered colors.
  await button.evaluate(async (element) => {
    window.getComputedStyle(element).getPropertyValue('color');
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
  const colors = await button.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const [light, dark] = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
  const ratio = (light + 0.05) / (dark + 0.05);
  assert.ok(ratio >= 4.5, `${state}: approval text needs 4.5:1 contrast, got ${ratio.toFixed(2)} (${JSON.stringify(colors)})`);
}

/** Real renderer styling, fake approval only: never connect to SSH or a model. */
export async function checkApprovalContrast(page, output) {
  const originalScheme = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const card = page.getByRole('region', { name: '命令审批', exact: true });
  const approve = card.getByRole('button', { name: '批准这次操作', exact: true });
  assert.equal(await approve.isEnabled(), true);
  try {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.mouse.move(0, 0);
      await assertReadable(approve, `${theme}/normal`);
      await approve.hover();
      await assertReadable(approve, `${theme}/hover`);
      await page.mouse.move(0, 0);
      await card.getByRole('button', { name: '拒绝', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await approve.evaluate((element) => document.activeElement === element), true);
      await assertReadable(approve, `${theme}/keyboard-focus`);
      await card.screenshot({ path: path.join(output, `approval-${theme}.png`) });
    }
  } finally { await page.emulateMedia({ colorScheme: originalScheme }); }
}
