/* global window, document, ClipboardEvent, DataTransfer, CustomEvent */
import assert from 'node:assert/strict';
import process from 'node:process';
export async function checkMessageReferences(page, screenshot) {
  await page.reload();
  const input = page.getByRole('textbox', { name: '给 AI 的消息', exact: true });
  await input.waitFor();
  await page.getByRole('button', { name: /生产服务器 ubuntu@/u }).click();
  await input.fill('before  after');
  await input.evaluate((element) => {
    const range = document.createRange(); range.setStart(element.firstChild, 7); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const body = 'const sample = 1;\n'.repeat(15);
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, body);
  assert.equal(await input.getByRole('button', { name: '粘贴文本', exact: true }).count(), 1);
  assert.equal((await input.textContent()).includes('const sample'), false, 'paste is folded');
  await input.getByRole('button', { name: '粘贴文本', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '粘贴文本预览' });
  await preview.getByRole('textbox', { name: '编辑粘贴内容' }).fill(body + '// edited');
  await preview.getByRole('button', { name: '保存', exact: true }).click();
  const copied = await input.evaluate((element) => {
    const chip = element.querySelector('[data-reference]');
    const range = document.createRange(); range.selectNode(chip);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    range.setStartAfter(chip); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData('text/plain');
  });
  assert.equal(copied, body + '// edited', 'copy exposes original content, not the chip caption');
  assert.equal(await input.getByRole('button', { name: '粘贴文本', exact: true }).count(), 2);
  await input.getByRole('button', { name: '粘贴文本', exact: true }).nth(1).click();
  await preview.getByRole('textbox', { name: '编辑粘贴内容' }).fill('independent copy');
  await preview.getByRole('button', { name: '保存', exact: true }).click();
  await input.getByRole('button', { name: '粘贴文本', exact: true }).first().click();
  assert.equal(await preview.getByRole('textbox', { name: '编辑粘贴内容' }).inputValue(), body + '// edited');
  await page.keyboard.press('Escape');
  const cut = await input.evaluate((element) => {
    const chip = element.querySelectorAll('[data-reference]')[1];
    const range = document.createRange(); range.selectNode(chip);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('cut', { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData('text/plain');
  });
  assert.equal(cut, 'independent copy');
  assert.equal(await input.getByRole('button', { name: '粘贴文本', exact: true }).count(), 1);
  await page.getByRole('button', { name: '引用输出', exact: true }).click();
  await input.getByRole('button', { name: 'Terminal', exact: true }).waitFor();
  assert.equal(await page.locator('.xterm-helper-textarea').evaluate((element) => document.activeElement === element), true, 'adding reference keeps terminal focus');
  await input.getByRole('button', { name: 'Terminal', exact: true }).click();
  const terminal = page.getByRole('dialog', { name: '终端引用预览' });
  await terminal.getByText(/service:latest/u).waitFor();
  assert.equal(await terminal.getByRole('textbox').count(), 0, 'terminal original is readonly');
  await page.keyboard.press('Escape');
  await screenshot('message-inline-references.png');
  await input.focus();
  await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await input.getByRole('button', { name: 'Terminal', exact: true }).count(), 0, 'terminal insertion is undoable');
  await input.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await input.getByRole('button', { name: 'Terminal', exact: true }).waitFor();
  await input.press('Enter');
  const message = page.getByRole('article', { name: '用户消息', exact: true }).last();
  await message.getByRole('button', { name: 'Terminal', exact: true }).waitFor();
  const sent = await page.evaluate(() => window.fixture.calls.filter((call) => call.kind === 'structured').at(-1).input.document.parts);
  assert.deepEqual(sent.map((part) => part.type), ['text', 'reference', 'reference', 'text']);
  assert.equal(sent[1].content, body + '// edited');
  await message.getByRole('button', { name: '粘贴文本', exact: true }).click();
  await page.getByRole('dialog', { name: '粘贴文本预览' }).getByText(/edited/u).waitFor();
  await screenshot('message-history-reference.png');
  await page.keyboard.press('Escape');
  // Native/context-menu paste goes through the same fold rule.
  await input.focus();
  await input.evaluate((element, text) => element.dispatchEvent(new CustomEvent('cloudhelm-paste', { detail: text })), body);
  assert.equal(await input.getByRole('button', { name: '粘贴文本', exact: true }).count(), 1);
  await input.getByRole('button', { name: '移除 粘贴文本' }).click();
}
