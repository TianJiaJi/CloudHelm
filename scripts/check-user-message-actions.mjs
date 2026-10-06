/* global window, navigator, document, getComputedStyle */
import assert from 'node:assert/strict';

export async function checkUserMessageActions(page, screenshot) {
  const message = page.getByRole('article', { name: '用户消息', exact: true }).first();
  const copy = message.getByRole('button', { name: '复制消息', exact: true });
  const edit = message.getByRole('button', { name: '编辑消息', exact: true });
  const composer = page.getByRole('textbox', { name: '给 AI 的消息', exact: true });
  const originalText = await message.locator(':scope > p').innerText();
  const composerDraft = await composer.inputValue();
  await page.evaluate(() => {
    window.fixture.messageClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.fixture.messageCopied = text; }
    } });
  });
  await composer.focus();
  await composer.hover();
  assert.equal(await copy.evaluate((button) => getComputedStyle(button.parentElement).opacity), '0');
  await message.hover();
  assert.equal(await copy.evaluate((button) => getComputedStyle(button.parentElement).opacity), '1');
  const timestamp = await message.locator('time').getAttribute('datetime');
  assert.equal(timestamp, await page.evaluate(async () => new Date((await window.cloudhelm.snapshot()).messages.find((item) => item.role === 'user').createdAt).toISOString()));
  assert.match(await message.locator('time').getAttribute('title'), /^发送时间：\d{4}/u);
  await screenshot('user-message-hover.png');
  await copy.click();
  assert.equal(await page.evaluate(() => window.fixture.messageCopied), originalText);
  await message.getByRole('status').filter({ hasText: '消息已复制' }).waitFor();
  await edit.click();
  const editor = message.getByRole('textbox', { name: '编辑消息内容', exact: true });
  assert.equal(await editor.inputValue(), originalText);
  assert.equal(await message.getByRole('button', { name: '发送修改', exact: true }).isDisabled(), true);
  await editor.fill('取消的修改');
  await editor.press('Escape');
  assert.equal(await editor.count(), 0);
  assert.equal(await message.locator(':scope > p').innerText(), originalText);
  await composer.hover();
  assert.equal(await edit.evaluate((button) => document.activeElement === button), true);
  assert.equal(await copy.evaluate((button) => getComputedStyle(button.parentElement).opacity), '1', 'Keyboard focus reveals message actions');
  await edit.press('Enter');
  await editor.fill('重新检查磁盘占用\n请同时查看 inode');
  await edit.click();
  assert.equal(await editor.inputValue(), '重新检查磁盘占用\n请同时查看 inode', 'Reopening edit must not discard unsent changes');
  await page.setViewportSize({ width: 980, height: 640 });
  await message.getByRole('button', { name: '发送修改', exact: true }).scrollIntoViewIfNeeded();
  await screenshot('user-message-edit-small.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth), false);
  await page.evaluate(() => {
    window.fixture.originalMessageSend = window.cloudhelm.sendMessage;
    window.cloudhelm.sendMessage = async () => { throw new Error('消息发送失败，请重试'); };
  });
  await message.getByRole('button', { name: '发送修改', exact: true }).click();
  const failure = page.getByRole('alertdialog');
  await failure.waitFor();
  await failure.getByRole('button', { name: '知道了', exact: true }).click();
  assert.equal(await editor.inputValue(), '重新检查磁盘占用\n请同时查看 inode', 'Failed sends preserve the edit');
  await page.evaluate(() => { window.cloudhelm.sendMessage = window.fixture.originalMessageSend; });
  const priorSends = await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'send').length);
  await message.getByRole('button', { name: '发送修改', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  const sends = await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'send'));
  assert.equal(sends.length, priorSends + 1);
  assert.equal(sends.at(-1).message, '重新检查磁盘占用\n请同时查看 inode');
  assert.equal(sends.at(-1).id, await page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations[0].id));
  assert.equal(await message.locator(':scope > p').innerText(), originalText, 'Editing sends a new message without rewriting history');
  assert.equal(await composer.inputValue(), composerDraft, 'Inline editing preserves the main composer draft');
  await page.evaluate(() => {
    if (window.fixture.messageClipboard) Object.defineProperty(navigator, 'clipboard', window.fixture.messageClipboard);
    else delete navigator.clipboard;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
}
