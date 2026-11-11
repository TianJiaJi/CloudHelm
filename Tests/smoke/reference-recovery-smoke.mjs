/* global window */
import assert from 'node:assert/strict';
import { checkReferenceDraftLifecycle } from './check-reference-draft-lifecycle.mjs';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { quietDesktopEnvironment, quietElectron as electron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop'), main = path.join(desktop, 'out/main/index.js');
const desktopRequire = createRequire(path.join(desktop, 'package.json')), executablePath = desktopRequire('electron');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-reference-recovery-'));
const primaryPath = path.join(temporary, 'primary'), otherPath = path.join(temporary, 'other');
await mkdir(primaryPath); await mkdir(otherPath);
const instances = new Set(), errors = [];
function environment(userData) {
  const env = { ...process.env, CLOUDHELM_USER_DATA: userData };
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(key)
    || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG'].includes(key)) delete env[key];
  return env;
}
async function launch(userData) {
  const application = await electron.launch({ executablePath, args: [main], env: environment(userData), timeout: 30_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  const page = await application.firstWindow({ timeout: 30_000 }); await owner.capture();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  const appName = await application.evaluate(({ app }) => app.getName());
  return { application, page, owner, appName, close: async () => { await owner.close(); instances.delete(owner); } };
}
function inspect(action) {
  const database = new Database(path.join(primaryPath, 'cloudhelm.sqlite'));
  try { return action(database); } finally { database.close(); }
}
function seed(database) {
  const put = database.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  put.run('tasks', 'kept-task', JSON.stringify({ id: 'kept-task', goal: 'Synthetic preserved owner', hostIds: [], localScopes: [], status: 'answered',
    provider: 'vercel-ai-gateway', modelId: 'anthropic/claude-sonnet-4.5', requestCount: 0, requestLimit: 100,
    createdAt: 1, updatedAt: 1, session: { version: 1, id: 'kept-task' } }));
  for (const id of ['stale', 'legacy', 'bound', 'published']) {
    const reference = { id: `copy-${id}`, kind: 'paste', capturedAt: 1 };
    database.prepare('INSERT INTO content_references(id,value) VALUES(?,?)').run(reference.id, JSON.stringify({ reference, original: `synthetic ${id}` }));
    database.prepare('INSERT INTO reference_preparations(request_id,conversation_id,reference_ids,producer_id) VALUES(?,?,?,?)')
      .run(id, id === 'bound' ? 'kept-task' : null, JSON.stringify([reference.id]), id === 'legacy' ? null : 'synthetic-prior-guarded-producer');
    put.run('message-receipts', id, JSON.stringify({ state: 'dispatching', fingerprint: 'synthetic', ...(id === 'bound' ? { conversationId: 'kept-task' } : {}) }));
    if (id === 'published') put.run('messages', 'published-message', JSON.stringify({ taskId: 'kept-task', role: 'user', text: 'Synthetic published input', createdAt: 1,
      document: { requestId: id, parts: [{ type: 'reference', reference }] } }));
  }
}
async function duplicate(appName) {
  // Use the actual primary's application identity, not the bootstrap file's inferred name.
  const gate = path.join(temporary, 'secondary-start-gate');
  const child = spawn(executablePath, [path.join(root, 'Tests/smoke/profile-lock-bootstrap.mjs'), main, gate],
    { env: { ...await quietDesktopEnvironment(environment(primaryPath), main), CLOUDHELM_TEST_APP_NAME: appName },
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let diagnostic = '';
  child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  void exit.catch(() => {});
  const owner = new DesktopProcess({ process: () => child, close: async () => {} }); instances.add(owner);
  await owner.capture(); await writeFile(gate, 'synthetic ownership captured', { flag: 'wx' });
  const result = await withTimeout(() => exit, 20_000, 'Secondary profile instance exit').catch(() => {
    const markers = ['READY', 'IMPORT_STARTED', 'IMPORTED', 'IMPORT_FAILED', 'WINDOW', 'QUIT'].filter((value) => diagnostic.includes(`PROFILE_${value}\n`));
    throw new Error(`Secondary instance failed to exit; fixture phases: ${markers.join(',')}`);
  });
  assert.deepEqual(result, { code: 0, signal: null }); await owner.waitForExit(); instances.delete(owner);
}
try {
  const primary = await launch(primaryPath); inspect(seed);
  const count = () => inspect((database) => database.prepare('SELECT count(*) AS n FROM reference_preparations').get().n);
  assert.equal(count(), 4);
  await duplicate(primary.appName); assert.equal(count(), 4); // Secondary startup did not open/recover this profile.
  const other = await launch(otherPath); assert.equal(count(), 4); await other.close();
  await primary.owner.crash(); instances.delete(primary.owner);
  const recovered = await launch(primaryPath);
  const presence = await recovered.page.evaluate(async () => {
    const result = {};
    for (const id of ['stale', 'legacy', 'bound', 'published']) {
      try { await window.cloudhelm.readReference(`copy-${id}`); result[id] = true; } catch { result[id] = false; }
    }
    return result;
  });
  assert.deepEqual(presence, { stale: false, legacy: true, bound: true, published: true });
  inspect((database) => {
    const state = (id) => JSON.parse(database.prepare("SELECT value FROM records WHERE bucket='message-receipts' AND id=?").get(id).value).state;
    assert.equal(state('stale'), 'failed');
    for (const id of ['legacy', 'bound', 'published']) assert.equal(state(id), 'dispatching');
    assert.equal(database.prepare('SELECT count(*) AS n FROM reference_preparations').get().n, 3);
  });
  const drafts = await checkReferenceDraftLifecycle(recovered, inspect, path.join(desktop, 'out/preload/index.cjs'));
  await recovered.close(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ check: 'reference-recovery-smoke', ...drafts, duplicateRejectedBeforeRecovery: true, differentProfileIndependent: true,
    crashRecovery: true, guardedUnboundReclaimed: true, legacyAndUnknownEvidencePreserved: true, paidModelRequests: 0, virtualMachineConnections: 0 }));
} finally { await cleanupDesktopSmoke(instances, temporary, (message) => console.warn(message)); }
