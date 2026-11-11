/* global window */
import assert from 'node:assert/strict';
import console from 'node:console';
import { access, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { _electron as electron, expect } from '@playwright/test';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

// Fresh synthetic data only. Never restores a runner, configures credentials or connects a host.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-deletion-smoke-'));
const databasePath = path.join(userData, 'cloudhelm.sqlite'), sessions = path.join(userData, 'pi-sessions');
const environment = { ...process.env, CLOUDHELM_USER_DATA: userData };
for (const name of Object.keys(environment)) {
  if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(name) || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG'].includes(name)) delete environment[name];
}
const instances = new Set(), errors = [];
const exists = (file) => access(file).then(() => true, () => false);
async function launch() {
  const application = await electron.launch({ executablePath: desktopRequire('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: environment, timeout: 30_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  const page = await application.firstWindow({ timeout: 30_000 }); await owner.capture();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  return { page, close: async () => { await owner.close(); instances.delete(owner); } };
}
try {
  // Let production migrations initialize the store; seed records only while Electron is closed.
  const first = await launch(); await first.close();
  const database = new Database(databasePath);
  try {
    const put = database.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
    for (const id of ['delete-normal', 'delete-deferred', 'keep-other']) {
      put.run('tasks', id, JSON.stringify({ id, goal: id, hostIds: [], localScopes: [], status: 'answered',
        provider: 'vercel-ai-gateway', modelId: 'anthropic/claude-sonnet-4.5', requestCount: 0, requestLimit: 100,
        createdAt: 1, updatedAt: 1, session: { version: 1, id } }));
      const reference = { id: `prepared-${id}`, kind: 'paste', capturedAt: 1 };
      database.prepare('INSERT INTO content_references(id,value) VALUES(?,?)')
        .run(reference.id, JSON.stringify({ reference, original: 'synthetic held copy, never dispatched' }));
      database.prepare('INSERT INTO reference_preparations(request_id,conversation_id,reference_ids) VALUES(?,?,?)')
        .run(`request-${id}`, id, JSON.stringify([reference.id]));
      put.run('message-receipts', `request-${id}`, JSON.stringify({ fingerprint: 'synthetic', state: 'dispatching', conversationId: id }));
      await mkdir(path.join(sessions, id), { recursive: true });
      await writeFile(path.join(sessions, id, 'native.jsonl'), 'synthetic session, never restored');
    }
  } finally { database.close(); }
  const deferred = path.join(sessions, 'delete-deferred'), saved = path.join(userData, 'saved-session');
  const foreign = path.join(userData, 'unrelated'), foreignFile = path.join(foreign, 'keep.txt');
  await mkdir(foreign); await writeFile(foreignFile, 'synthetic unrelated data');
  await rename(deferred, saved); await symlink(foreign, deferred, 'junction');
  const second = await launch();
  await withTimeout(() => second.page.evaluate(() => window.cloudhelm.deleteConversation('delete-normal')), 30_000, 'Normal deletion');
  assert.equal(await exists(path.join(sessions, 'delete-normal')), false);
  const warning = await withTimeout(() => second.page.evaluate(async () => {
    try { await window.cloudhelm.deleteConversation('delete-deferred'); return ''; }
    catch (error) { return error.message; }
  }), 30_000, 'Deferred deletion');
  assert.match(warning, /对话记录已删除/u);
  assert.equal(warning.includes(userData), false);
  const ids = await second.page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations.map((task) => task.id));
  assert.deepEqual(ids, ['keep-other']); assert.equal(await exists(foreignFile), true);
  const referenceState = await second.page.evaluate(async () => {
    const removed = [];
    for (const id of ['prepared-delete-normal', 'prepared-delete-deferred']) {
      try { await window.cloudhelm.readReference(id); removed.push(false); } catch { removed.push(true); }
    }
    return { removed, retained: (await window.cloudhelm.readReference('prepared-keep-other')).original };
  });
  assert.deepEqual(referenceState, { removed: [true, true], retained: 'synthetic held copy, never dispatched' });
  await second.close();
  const pending = new Database(databasePath, { readonly: true });
  try {
    assert.equal(pending.prepare("SELECT count(*) AS count FROM records WHERE bucket='conversation-cleanups'").get().count, 1);
    assert.equal(pending.prepare("SELECT count(*) AS count FROM records WHERE bucket='tasks'").get().count, 1);
    assert.equal(pending.prepare('SELECT count(*) AS count FROM reference_preparations').get().count, 1);
    assert.deepEqual(pending.prepare('SELECT id FROM content_references').all(), [{ id: 'prepared-keep-other' }]);
  } finally { pending.close(); }
  // Repair the synthetic root substitution. Production startup must consume the durable redo receipt.
  await rm(deferred, { recursive: true }); await rename(saved, deferred);
  const third = await launch();
  await expect.poll(() => exists(deferred), { timeout: 15_000 }).toBe(false);
  assert.equal(await exists(path.join(sessions, 'keep-other', 'native.jsonl')), true);
  assert.equal(await exists(foreignFile), true);
  assert.deepEqual(await third.page.evaluate(async () => (await window.cloudhelm.snapshot()).conversations.map((task) => task.id)), ['keep-other']);
  await third.close();
  const recovered = new Database(databasePath, { readonly: true });
  try { assert.equal(recovered.prepare("SELECT count(*) AS count FROM records WHERE bucket='conversation-cleanups'").get().count, 0); }
  finally { recovered.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ check: 'conversation-deletion-smoke', normalDeletion: true, deferredCleanup: true,
    restartRecovery: true, unrelatedDataPreserved: true, preparedReferencesReclaimed: true, otherReferenceRetained: true,
    paidModelRequests: 0, virtualMachineConnections: 0 }));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(message));
}
