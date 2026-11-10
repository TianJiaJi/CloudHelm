/* global window */
import assert from 'node:assert/strict';

export async function checkModelButtonHover(page, screenshot) {
  const save = page.getByRole('button', { name: '保存为默认', exact: true });
  const url = page.locator('#model-base-url');
  const originalUrl = await url.inputValue();
  const appearance = (button) => button.evaluate((element) => {
    const css = window.getComputedStyle(element);
    return { background: css.backgroundColor, color: css.color, opacity: css.opacity, cursor: css.cursor, filter: css.filter };
  });
  async function enabledHover(button) {
    await page.mouse.move(0, 0);
    assert.equal(await button.isEnabled(), true);
    const normal = await appearance(button);
    await button.hover();
    const hovered = await appearance(button);
    assert.equal(hovered.background, normal.background, 'Primary hover must retain its accent fill, not inherit the generic gray hover');
    assert.equal(hovered.color, normal.color);
    assert.equal(hovered.opacity, '1'); assert.equal(hovered.cursor, 'pointer');
    assert.equal(hovered.filter, 'brightness(1.06)');
    return normal;
  }
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    const normal = await enabledHover(save);
    await screenshot(`model-save-hover-${theme}.png`);
    await url.fill('');
    assert.equal(await save.isDisabled(), true, 'An invalid form must still disable saving');
    await save.hover();
    const disabled = await appearance(save);
    assert.equal(disabled.background, normal.background);
    assert.equal(disabled.cursor, 'not-allowed'); assert.equal(disabled.filter, 'none');
    assert.ok(Number(disabled.opacity) < Number(normal.opacity));
    await screenshot(`model-save-disabled-${theme}.png`);
    await url.fill(`${originalUrl}/hover-check`);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '还有未保存的更改', exact: true });
    await enabledHover(dialog.getByRole('button', { name: '保存并继续', exact: true }));
    await screenshot(`model-dialog-save-hover-${theme}.png`);
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    await url.fill(originalUrl);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}
