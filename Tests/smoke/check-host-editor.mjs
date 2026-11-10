/* global window */
import assert from 'node:assert/strict';

export async function configureHostEditor(page, dialog, screenshot) {
  assert.equal(await dialog.getByRole('tab').count(), 8);
  assert.equal(await dialog.getByLabel('认证方式').locator('option[value="agent"]:not([disabled])').count(), 0);
  await dialog.getByLabel('私钥口令（如有）', { exact: true }).fill('fixture-key-passphrase');
  await dialog.getByLabel('清除已存SSH 密码（后备认证）', { exact: true }).check();
  await dialog.getByRole('button', { name: '下移私钥', exact: true }).click();
  await dialog.getByRole('tab', { name: '常规', exact: true }).click();
  await dialog.getByLabel('分组', { exact: true }).fill('生产环境');
  await dialog.getByLabel('备注', { exact: true }).fill('Synthetic editor acceptance');
  await dialog.getByRole('tab', { name: '连接', exact: true }).click();
  await dialog.getByLabel('SSH 握手与认证超时（秒）').fill('300');
  await dialog.getByLabel('SSH 心跳间隔（秒，0 表示关闭）').fill('0');
  await dialog.getByLabel('心跳最大未响应次数').fill('5');
  await dialog.getByRole('tab', { name: '代理', exact: true }).click();
  await dialog.getByLabel('启用连接代理').check();
  await dialog.getByLabel('代理协议').selectOption('https');
  await dialog.getByLabel('代理地址').fill('proxy.example.test');
  const proxyPort = dialog.getByLabel('代理端口');
  await proxyPort.fill('');
  assert.equal(await proxyPort.inputValue(), '', 'An empty proxy port must not become zero');
  assert.equal(await proxyPort.evaluate((input) => input.validity.valueMissing), true);
  await proxyPort.pressSequentially('8443');
  assert.equal(await proxyPort.inputValue(), '8443');
  await dialog.getByLabel('代理用户名（可选）').fill('fixture-proxy');
  await dialog.getByLabel('代理密码', { exact: true }).fill('fixture-proxy-password');
  await screenshot('host-editor-proxy.png');
  await dialog.getByRole('tab', { name: '终端与文件', exact: true }).click();
  await dialog.getByLabel('终端编码').selectOption('gbk');
  await dialog.getByLabel('TERM', { exact: true }).fill('vt100');
  await dialog.getByLabel('禁用文件列表自动监控').check();
  await dialog.getByLabel('禁用 pwd 目录跟随').check();
  await dialog.getByRole('tab', { name: 'X11 转发', exact: true }).click();
  await dialog.getByLabel('启用 X11 转发').check();
  await dialog.getByLabel('本机显示号').fill('1');
  await dialog.getByLabel('Cookie 模式').selectOption('manual');
  await dialog.getByLabel('X11 Cookie', { exact: true }).fill('42'.repeat(16));
  await dialog.getByRole('tab', { name: '算法', exact: true }).click();
  await dialog.getByLabel('使用默认主机密钥算法').uncheck();
  await dialog.getByLabel('主机密钥算法', { exact: true }).selectOption(['ssh-ed25519']);
  await dialog.getByRole('tab', { name: '启动设置', exact: true }).click();
  await dialog.getByLabel('默认目录').fill('/srv/fixture');
  await dialog.getByLabel('初始化命令').fill('printf fixture');
  await dialog.getByLabel('自定义保活命令', { exact: true }).fill('pwd');
  await dialog.getByLabel('自定义保活周期（秒）').fill('20');
  await dialog.getByRole('button', { name: '添加环境变量', exact: true }).click();
  await dialog.getByLabel('环境变量名称 1', { exact: true }).fill('LANG');
  await dialog.getByLabel('环境变量值 1', { exact: true }).fill('C.UTF-8');
  await screenshot('host-editor-startup.png');
  await dialog.getByRole('tab', { name: '常规', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.savedHost), undefined, 'Configuring settings must not save or connect');
}

export async function assertHostEditorSaved(page) {
  const saved = await page.evaluate(() => window.fixture.savedHost);
  assert.equal(saved.draft.group, '生产环境');
  assert.equal(saved.draft.notes, 'Synthetic editor acceptance');
  assert.deepEqual(saved.credentials, { password: null, passphrase: 'fixture-key-passphrase', proxyPassword: 'fixture-proxy-password', x11Cookie: '42'.repeat(16) });
  assert.equal(saved.secret, undefined, 'Do not reinterpret purpose-bound credential patches as one legacy secret');
  const settings = saved.draft.connection;
  assert.deepEqual(settings.authOrder, ['password', 'private-key', 'keyboard-interactive']);
  assert.equal(settings.timeoutMs, 300000); assert.equal(settings.keepaliveIntervalMs, 0); assert.equal(settings.keepaliveCountMax, 5);
  assert.deepEqual(settings.proxy, { enabled: true, protocol: 'https', address: 'proxy.example.test', port: 8443, username: 'fixture-proxy' });
  assert.deepEqual(settings.terminal, { encoding: 'gbk', term: 'vt100' });
  assert.deepEqual(settings.files, { watch: false, followCwd: false });
  assert.deepEqual(settings.x11, { enabled: true, display: 1, screen: 0, cookie: 'manual' });
  assert.deepEqual(settings.algorithms.hostKey, ['ssh-ed25519']);
  assert.deepEqual(settings.session, { directory: '/srv/fixture', initialization: 'printf fixture', keepaliveCommand: 'pwd', keepaliveIntervalMs: 20000, environment: [{ name: 'LANG', value: 'C.UTF-8' }] });
  assert.equal(JSON.stringify(saved.draft).includes('fixture-key-passphrase'), false);
  assert.equal(JSON.stringify(saved.draft).includes('fixture-proxy-password'), false);
  assert.equal(JSON.stringify(saved.draft).includes('42'.repeat(16)), false);
}
