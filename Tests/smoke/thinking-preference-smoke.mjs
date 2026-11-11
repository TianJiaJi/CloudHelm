/* global window, Buffer */
import assert from 'node:assert/strict';
import console from 'node:console';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { _electron as electron, expect } from '@playwright/test';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

// Synthetic loopback host and invalid ciphertext only; no user profile or paid endpoint access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop'), desktopRequire = createRequire(path.join(desktop, 'package.json'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-thinking-smoke-'));
const databasePath = path.join(userData, 'cloudhelm.sqlite');
const instances = new Set(), errors = [];
let sshConnections = 0;
const trap = createServer((socket) => { sshConnections++; socket.destroy(); });
const env = { ...process.env, CLOUDHELM_USER_DATA: userData };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(key)
  || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG'].includes(key)) delete env[key];
async function launch() {
  const app = await electron.launch({ executablePath: desktopRequire('electron'), args: [path.join(desktop, 'out/main/index.js')], env, timeout: 30_000 });
  const owner = new DesktopProcess(app); instances.add(owner); await owner.capture();
  const page = await app.firstWindow({ timeout: 30_000 }); await owner.capture();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  return { app, page, close: async () => { await owner.close(); instances.delete(owner); } };
}
try {
  await new Promise((resolve, reject) => { trap.once('error', reject); trap.listen(0, '127.0.0.1', resolve); });
  const first = await launch(); await first.close();
  const database = new Database(databasePath);
  try {
    const put = database.prepare('INSERT OR REPLACE INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
    const profile = { provider: 'deepseek', modelId: 'deepseek-flash', credentialRevision: 'synthetic-revision' };
    put.run('settings', 'model-profile', JSON.stringify(profile));
    put.run('settings', 'model-provider:deepseek', JSON.stringify(profile));
    put.run('secrets', 'model-key:deepseek', JSON.stringify(Buffer.from('synthetic-invalid-ciphertext').toString('base64')));
    put.run('hosts', 'loopback-host', JSON.stringify({ id: 'loopback-host', label: 'Synthetic loopback', address: '127.0.0.1', port: trap.address().port,
      username: 'synthetic', auth: 'password', protectedPaths: [], defaultMode: 'ask', policyRevision: 1, status: 'disconnected' }));
    put.run('tasks', 'preference-fixture', JSON.stringify({ id: 'preference-fixture', goal: 'Offline preference fixture', ...profile,
      hostIds: ['loopback-host'], localScopes: [], status: 'answered', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1,
      session: { version: 1, id: 'preference-fixture' }, thinking: { levels: ['off', 'low', 'high', 'max'], selected: 'off', effective: 'off', pending: false } }));
  } finally { database.close(); }
  const second = await launch();
  await second.app.evaluate(({ safeStorage }) => {
    globalThis.__thinkingCredentialChecks = 0;
    safeStorage.isEncryptionAvailable = () => { globalThis.__thinkingCredentialChecks++; return false; };
    safeStorage.decryptString = () => { globalThis.__thinkingCredentialChecks++; throw new Error('Forbidden synthetic credential access'); };
  });
  assert.deepEqual(await second.page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations.map((task) => task.id)), ['preference-fixture']);
  await second.page.getByRole('button', { name: /Offline preference fixture/u }).click();
  await second.page.getByRole('button', { name: '思考强度，当前 关闭', exact: true }).click();
  await second.page.getByRole('menuitem', { name: '高', exact: true }).click();
  await expect(second.page.getByRole('button', { name: '思考强度，当前 高', exact: true })).toHaveAttribute('title', '下一次模型请求生效');
  await withTimeout(() => second.page.evaluate(() => window.cloudhelm.setConversationThinking('preference-fixture', 'max')), 15_000, 'Offline preference');
  const snapshot = await second.page.evaluate(() => window.cloudhelm.snapshot());
  assert.equal(snapshot.conversations[0].preferredThinking, 'max');
  assert.equal(snapshot.conversations[0].thinking.pending, true);
  assert.equal(snapshot.conversations[0].status, 'answered'); assert.equal(snapshot.conversations[0].requestCount, 0);
  assert.equal(snapshot.hosts[0].status, 'disconnected'); assert.equal(sshConnections, 0);
  assert.equal(await second.app.evaluate(() => globalThis.__thinkingCredentialChecks), 0);
  assert.equal(await access(path.join(userData, 'pi-sessions', 'preference-fixture')).then(() => true, () => false), false);
  await second.close();
  const third = await launch();
  const persisted = await third.page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations[0]);
  assert.equal(persisted.preferredThinking, 'max'); assert.equal(persisted.thinking.selected, 'max');
  assert.equal(persisted.thinking.pending, true); assert.equal(sshConnections, 0);
  await third.close(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ check: 'thinking-preference-smoke', actualUiSelection: true, offlinePersistence: true,
    credentialChecks: 0, sshConnections, restoredAgent: false, restartPersistence: true, paidModelRequests: 0 }));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(message));
  await new Promise((resolve) => trap.close(resolve));
}
