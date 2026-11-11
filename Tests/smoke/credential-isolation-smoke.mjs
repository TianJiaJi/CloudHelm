/* global window, Buffer */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { quietElectron as electron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';

// A fresh, synthetic database only. No user credentials, hosts, model calls or SSH.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-broken-credential-smoke-'));
const databasePath = path.join(userData, 'cloudhelm.sqlite');
const invalidCiphertext = Buffer.from('synthetic-invalid-ciphertext-not-a-key').toString('base64');
const choice = { provider: 'cloudhelm-custom', modelId: 'synthetic-model', baseUrl: 'http://127.0.0.1:9/v1', credentialRevision: 'synthetic-old-revision' };
const database = new Database(databasePath);
database.exec(`CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(bucket,id));`);
const put = database.prepare('INSERT INTO records VALUES(?,?,?,1)');
put.run('settings', 'model-profile', JSON.stringify(choice));
put.run('settings', 'model-provider:cloudhelm-custom', JSON.stringify(choice));
put.run('secrets', 'model-key:cloudhelm-custom', JSON.stringify(invalidCiphertext));
database.close();
const environment = { ...process.env, CLOUDHELM_USER_DATA: userData };
for (const name of Object.keys(environment)) {
  if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(name) || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG'].includes(name)) delete environment[name];
}
const instances = new Set();
try {
  const application = await electron.launch({ executablePath: desktopRequire('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: environment, timeout: 30_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  const page = await application.firstWindow({ timeout: 30_000 }); await owner.capture();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 30_000 });
  const invalid = await application.evaluate(({ safeStorage }, ciphertext) => {
    try { safeStorage.decryptString(Buffer.from(ciphertext, 'base64')); return false; }
    catch { return true; }
  }, invalidCiphertext);
  assert.equal(invalid, true, 'The fixture must actually be undecryptable by Electron');
  await application.evaluate(({ safeStorage }) => {
    globalThis.__cloudhelmSmokeAvailability = safeStorage.isEncryptionAvailable;
    safeStorage.isEncryptionAvailable = () => false;
  });
  const projection = await withTimeout(() => page.evaluate(async () => {
    await window.cloudhelm.saveReviewSettings({ reviewer: { kind: 'current' } });
    const snapshot = await window.cloudhelm.snapshot();
    return { hasKey: snapshot.profile.hasKey, hostCount: snapshot.hosts.length,
      settingsHasKey: (await window.cloudhelm.modelProviderSettings('cloudhelm-custom')).hasKey,
      configuredModel: (await window.cloudhelm.availableModels()).some((model) => model.modelId === 'synthetic-model') };
  }), 30_000, 'Unavailable credential projection');
  assert.deepEqual(projection, { hasKey: true, hostCount: 0, settingsHasKey: true, configuredModel: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor({ timeout: 15_000 });
  await application.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = globalThis.__cloudhelmSmokeAvailability;
    delete globalThis.__cloudhelmSmokeAvailability;
  });
  const repaired = await withTimeout(() => page.evaluate(async (draft) => {
    await window.cloudhelm.saveModelProfile({ ...draft, apiKey: 'synthetic-replacement-for-smoke-only' });
    const snapshot = await window.cloudhelm.snapshot();
    return { hasKey: snapshot.profile.hasKey, revision: snapshot.profile.credentialRevision };
  }, choice), 30_000, 'Explicit credential replacement');
  assert.equal(repaired.hasKey, true); assert.notEqual(repaired.revision, choice.credentialRevision);
  assert.deepEqual(errors, []);
  await owner.close(); instances.delete(owner);
  const bytes = await readFile(databasePath);
  assert.equal(bytes.includes(Buffer.from('synthetic-replacement-for-smoke-only')), false);
  console.log(JSON.stringify({ check: 'credential-isolation-smoke', startupWithBrokenCredential: true,
    settingsWhileUnavailable: true, explicitReplacement: true, persistedPlaintext: false,
    paidModelRequests: 0, virtualMachineConnections: 0 }));
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(message));
}
