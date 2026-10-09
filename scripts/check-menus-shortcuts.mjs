/* global window, navigator */
import assert from 'node:assert/strict';

/**
 * Exercises every right-click menu group plus the shortcut settings panel:
 * entry presence, shortcut hints, disabled states, key recording with conflict
 * rejection, the master switch and reset, and the delete-conversation guard.
 */
export async function checkMenusAndShortcuts(page, screenshot) {
  const isMac = await page.evaluate(() => /mac|iphone|ipad/iu.test(`${navigator.platform} ${navigator.userAgent}`));
  const modifier = isMac ? 'Meta' : 'Control';
  // Message menu: copy text and edit stay available from the right click.
  const message = page.getByRole('article', { name: '用户消息', exact: true }).first();
  await message.click({ button: 'right' });
  const messageMenu = page.getByRole('menu', { name: '消息操作' });
  await messageMenu.waitFor();
  assert.equal(await messageMenu.getByRole('menuitem', { name: '复制文本' }).count(), 1);
  assert.equal(await messageMenu.getByRole('menuitem', { name: '编辑消息' }).count(), 1);
  await screenshot('context-menu-message.png');
  await page.keyboard.press('Escape');
  await messageMenu.waitFor({ state: 'hidden' });
  // A pointer menu survives its opening mouseup, then closes on an outside click.
  await message.click({ button: 'right' });
  await messageMenu.waitFor();
  await page.getByRole('textbox', { name: '给 AI 的消息', exact: true }).click();
  await messageMenu.waitFor({ state: 'hidden' });

  // Terminal menu: always opens, copy is disabled without a selection, and every
  // terminal action advertises its effective default shortcut.
  const terminal = page.locator('[data-shortcut-scope="terminal"]');
  // macOS xterm selects the word under a right click; use a blank row to test
  // the no-selection state consistently on every platform.
  const blankRow = { x: 60, y: (await terminal.boundingBox()).height - 30 };
  await terminal.click({ position: blankRow });
  await terminal.click({ button: 'right', position: blankRow });
  const terminalMenu = page.getByRole('menu', { name: '终端操作' });
  await terminalMenu.waitFor();
  assert.equal(await terminalMenu.getByRole('menuitem', { name: '引用输出到 AI' }).count(), 1);
  assert.equal(await terminalMenu.getByRole('menuitem', { name: '清屏（仅本地显示）' }).count(), 1);
  assert.equal(await terminalMenu.getByRole('menuitem', { name: '新终端' }).count(), 1);
  assert.equal(await terminalMenu.getByRole('menuitem', { name: '复制' }).isDisabled(), true, 'terminal copy is disabled without a selection');
  const terminalHint = (name) => terminalMenu.getByRole('menuitem', { name }).locator('kbd').first();
  assert.equal(await terminalHint('复制').textContent(), isMac ? '⇧⌘C' : 'Ctrl+Shift+C', 'terminal copy shows its default shortcut');
  assert.equal(await terminalHint('粘贴').textContent(), isMac ? '⇧⌘V' : 'Ctrl+Shift+V');
  assert.equal(await terminalHint('全选').textContent(), isMac ? '⇧⌘A' : 'Ctrl+Shift+A');
  assert.equal(await terminalHint('引用输出到 AI').textContent(), isMac ? '⇧⌘Q' : 'Ctrl+Shift+Q');
  assert.equal(await terminalHint('清屏（仅本地显示）').textContent(), isMac ? '⇧⌘K' : 'Ctrl+Shift+K');
  assert.equal(await terminalHint('新终端').textContent(), isMac ? '⇧⌘T' : 'Ctrl+Shift+T', 'global shortcuts are advertised inside the terminal');
  assert.equal(await terminalMenu.locator('kbd', { hasText: '未设置' }).count(), 0, 'every terminal action has a default shortcut');
  await screenshot('context-menu-terminal.png');
  await page.keyboard.press('Escape');
  await terminalMenu.waitFor({ state: 'hidden' });

  // History row menu: delete asks for confirmation and lists what is removed.
  const row = page.locator('[class*=historyList] [class*=historyRow]').first();
  await row.click({ button: 'right' });
  const historyMenu = page.getByRole('menu', { name: /对话操作/u });
  await historyMenu.waitFor();
  assert.equal(await historyMenu.getByRole('menuitem', { name: '打开对话' }).count(), 1);
  assert.equal(await historyMenu.getByRole('menuitem', { name: '查看完整报告' }).count(), 1);
  assert.equal(await historyMenu.getByRole('menuitem', { name: '复制对话文本' }).count(), 1);
  await screenshot('context-menu-history.png');
  const remove = historyMenu.getByRole('menuitem', { name: '删除对话' });
  assert.equal(await remove.count(), 1);
  if (!(await remove.isDisabled())) {
    await remove.click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor();
    assert.match(await confirm.textContent(), /永久删除/u);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'delete-conversation').length)), 0,
      'canceling the dialog must not delete anything');
  } else {
    await page.keyboard.press('Escape');
  }
  await historyMenu.waitFor({ state: 'hidden' });

  // Edit menu on a native field with system editing hints.
  const composer = page.getByRole('textbox', { name: '给 AI 的消息', exact: true });
  await composer.click({ button: 'right' });
  const editMenu = page.getByRole('menu', { name: '编辑菜单' });
  await editMenu.waitFor();
  assert.equal(await editMenu.getByRole('menuitem', { name: '撤销' }).count(), 1);
  assert.equal(await editMenu.getByRole('menuitem', { name: '粘贴' }).count(), 1);
  assert.equal(await editMenu.getByRole('menuitem', { name: '全选' }).count(), 1);
  assert.ok(await editMenu.locator('kbd', { hasText: isMac ? '⌘C' : 'Ctrl+C' }).count(), 'editing shortcuts are shown as hints');
  await screenshot('context-menu-edit.png');
  await page.keyboard.press('Escape');
  await editMenu.waitFor({ state: 'hidden' });

  // Shortcut settings: recording, conflict rejection, switch, reset.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  await page.getByRole('tab', { name: '快捷键' }).click();
  const panel = page.getByRole('tabpanel');
  await panel.waitFor();
  assert.ok((await panel.locator('[class*=shortcutRow]').count()) >= 5);
  // Every row must stay reachable: the list must not clip its own content.
  const lastRow = panel.locator('[class*=shortcutRow]').last();
  await lastRow.scrollIntoViewIfNeeded();
  const rowBox = await lastRow.boundingBox();
  const detailBox = await panel.locator('[class*=detail]').boundingBox();
  assert.ok(rowBox && detailBox && rowBox.y + rowBox.height <= detailBox.y + detailBox.height + 1,
    'every shortcut row is visible inside the settings panel');
  await screenshot('shortcut-settings.png');
  const rowFor = (name) => panel.locator('[class*=shortcutRow]', { hasText: name }).first();
  assert.equal(await rowFor('关闭当前标签').locator('kbd').first().textContent(), isMac ? '⌘W' : 'Ctrl+W', 'default binding is shown');

  await rowFor('新终端').getByRole('button', { name: '更改' }).click();
  await panel.getByText('请按下新的快捷键').first().waitFor();
  await page.keyboard.press('Control+Alt+p');
  await rowFor('新终端').locator('kbd', { hasText: isMac ? '⌃⌥P' : 'Ctrl+Alt+P' }).waitFor();
  assert.ok((await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'shortcuts')))
    .some((call) => call.settings.bindings['terminal.new'] === 'ctrl+alt+p'), 'recorded binding is persisted');

  await rowFor('新对话').getByRole('button', { name: '更改' }).click();
  await page.keyboard.press(`${modifier}+w`);
  await panel.getByRole('alert').filter({ hasText: '已被' }).waitFor();
  await page.keyboard.press(`${modifier}+c`);
  await panel.getByRole('alert').filter({ hasText: '保留键位' }).waitFor();
  await page.keyboard.press('Escape');
  await rowFor('新对话').getByRole('button', { name: '更改' }).waitFor();

  const search = panel.getByRole('searchbox', { name: '搜索快捷键动作' });
  await search.fill('终端');
  assert.equal(await panel.locator('[class*=shortcutRow]', { hasText: '新终端' }).count(), 1, 'search finds matching actions across groups');
  assert.equal(await panel.locator('[class*=shortcutRow]', { hasText: '打开设置' }).count(), 0, 'search hides non-matching actions');
  await search.fill('');

  const master = panel.getByRole('checkbox');
  await master.click();
  assert.ok((await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'shortcuts')))
    .some((call) => call.settings.enabled === false), 'master switch is persisted');
  await master.click();

  await panel.getByRole('button', { name: '恢复全部默认' }).click();
  await rowFor('新终端').locator('kbd', { hasText: isMac ? '⇧⌘T' : 'Ctrl+Shift+T' }).waitFor();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor({ state: 'hidden' });
}
