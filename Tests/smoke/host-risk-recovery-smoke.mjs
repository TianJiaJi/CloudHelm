/* global window */
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
import { expect } from '@playwright/test';
import { quietElectron as electron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke } from './desktop-process.mjs';

// Real main/preload/worker + synthetic persisted operations. No remote execution or model calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop'), desktopRequire = createRequire(path.join(desktop, 'package.json'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-risk-recovery-'));
const instances = new Set(), errors = [];
let sshConnections = 0;
const trap = createServer((socket) => { sshConnections++; socket.destroy(); });
async function launch() {
  const app = await electron.launch({ executablePath: desktopRequire('electron'), args: [path.join(desktop, 'out/main/index.js')],
    env: { ...process.env, CLOUDHELM_USER_DATA: userData }, timeout: 30_000 });
  const owner = new DesktopProcess(app); instances.add(owner); await owner.capture();
  const page = await app.firstWindow({ timeout: 30_000 }); await owner.capture();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  return { app, page, close: async () => {
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const evidence = await app.evaluate(({ BrowserWindow }) => ({ violations: globalThis.__cloudhelmQuietDesktop.violations,
      windows: BrowserWindow.getAllWindows().map((item) => ({ visible: item.isVisible(), focused: item.isFocused(), focusable: item.isFocusable() })) }));
    assert.deepEqual(evidence, { violations: [], windows: [{ visible: false, focused: false, focusable: false }] });
    await owner.close(); instances.delete(owner);
  } };
}
async function selectCurrent(page) {
  await page.getByRole('button', { name: /Synthetic current revision/u }).click();
  return page.getByRole('region', { name: '本次远端写入风险确认', exact: true });
}
async function snapshot(page) { return page.evaluate(() => window.cloudhelm.snapshot()); }
try {
  await new Promise((resolve, reject) => { trap.once('error', reject); trap.listen(0, '127.0.0.1', resolve); });
  const first = await launch(); await first.close();
  const database = new Database(path.join(userData, 'cloudhelm.sqlite'));
  try {
    const put = (bucket, id, value) => database.prepare('INSERT OR REPLACE INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)').run(bucket, id, JSON.stringify(value));
    const host = { id: 'original', label: 'Synthetic old configuration', address: '127.0.0.1', port: trap.address().port,
      username: 'synthetic', auth: 'password', protectedPaths: [], defaultMode: 'ask', policyRevision: 1, status: 'disconnected' };
    put('hosts', host.id, { ...host, archived: true });
    put('hosts', 'current', { ...host, id: 'current', previousHostId: host.id, label: 'Synthetic new configuration', username: 'other-login' });
    for (const [id, hostId, goal] of [['source-task', 'original', 'Synthetic historical task'], ['current-task', 'current', 'Synthetic current revision']]) {
      put('tasks', id, { id, hostIds: [hostId], goal, provider: 'deepseek', modelId: 'deepseek-flash', localScopes: [], status: 'answered',
        requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1, session: { version: 1, id } });
    }
    for (const [id, createdAt] of [['unknown-first', 1], ['unknown-second', 2]]) {
      put('operations', id, { id, taskId: 'source-task', hostId: 'original', kind: 'write-file', preview: `Synthetic historical write ${id}`,
        status: 'unknown', effects: 'possible', createdAt });
    }
    put('operations', 'blocked-current', { id: 'blocked-current', taskId: 'current-task', hostId: 'current', kind: 'write-file',
      preview: 'Synthetic current write, never dispatched', status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation', createdAt: 3 });
  } finally { database.close(); }
  const second = await launch(), refused = await selectCurrent(second.page);
  await expect(refused).toContainText('待处理 1 / 2 项'); await expect(refused).toContainText('同一风险域（含历史配置）');
  await refused.getByRole('button', { name: '拒绝，保持阻断', exact: true }).click();
  assert.equal((await snapshot(second.page)).operations.some((operation) => operation.reconciledAt), false);
  await second.close();
  const third = await launch(), accepted = await selectCurrent(third.page);
  await expect(accepted).toContainText('待处理 1 / 2 项');
  await accepted.getByRole('button', { name: '知晓风险，仅解除这条写入阻断', exact: true }).click();
  await expect(accepted).toContainText('待处理 1 / 1 项'); await expect(accepted).toContainText('阻断项 unknown-second');
  const after = await snapshot(third.page), original = after.operations.find((operation) => operation.id === 'unknown-first');
  assert.equal(original.hostId, 'original'); assert.equal(original.status, 'unknown');
  assert.equal(original.reconciliation.kind, 'risk-accepted'); assert.equal(original.reconciliation.sourceTaskId, 'current-task');
  assert.deepEqual(original.reconciliation.evidenceOperationIds, []);
  assert.equal(after.operations.length, 3); assert.equal(after.operations.find((operation) => operation.id === 'unknown-second').reconciledAt, undefined);
  await third.close();
  const fourth = await launch(), restored = await selectCurrent(fourth.page);
  await expect(restored).toContainText('待处理 1 / 1 项'); await expect(restored).toContainText('阻断项 unknown-second');
  const persisted = await snapshot(fourth.page);
  assert.deepEqual(persisted.operations.find((operation) => operation.id === original.id).reconciliation, original.reconciliation);
  assert.equal(persisted.operations.length, 3); assert.ok(persisted.conversations.every((task) => task.requestCount === 0));
  assert.ok(persisted.hosts.every((host) => host.status === 'disconnected')); assert.equal(sshConnections, 0);
  for (const id of ['source-task', 'current-task']) assert.equal(await access(path.join(userData, 'pi-sessions', id)).then(() => true, () => false), false);
  await fourth.close(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ check: 'host-risk-recovery-smoke', hidden: true, nativeWindowEvents: 0,
    historicalRevisionVisible: true, refusalRetainsRisk: true, onlyOriginalOperationAccepted: true,
    remoteOutcomeStillUnknown: true, remainingRiskRestored: true, restartPersistence: true,
    automaticReplay: false, sshConnections, paidModelRequests: 0 }));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => { console.warn(message); process.exitCode = 1; });
  if (trap.listening) await new Promise((resolve) => trap.close(resolve));
}
