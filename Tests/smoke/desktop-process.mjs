import { rm } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { forceKill, ownedProcessTree, processTable, remainingIdentities, sameIdentity, validIdentity } from './desktop-process-identity.mjs';
export { forceKill } from './desktop-process-identity.mjs';

export async function withTimeout(action, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Liveness alone is never termination authority: the PID may have been reused. */
export function processRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Owns only captured identities of one isolated smoke instance. */
export class DesktopProcess {
  constructor(application) {
    this.application = application;
    this.child = application.process();
    if (!Number.isSafeInteger(this.child.pid) || this.child.pid <= 0) throw new Error('Electron has no valid PID');
    this.identities = new Map();
    this.rootIdentity = undefined;
  }

  get pids() { return new Set(this.identities.keys()); }
  get exited() { return this.child.exitCode !== null || this.child.signalCode !== null; }

  async capture() {
    if (!this.identities.size && this.exited) return;
    const table = await processTable();
    this.identities = remainingIdentities(this.identities, table);
    if (this.exited) return; // Keep captured orphans; never adopt a recycled root.
    const root = table.find((entry) => entry.pid === this.child.pid);
    if (!validIdentity(root) || root.parentPid !== process.pid
      || (this.rootIdentity && !sameIdentity(this.rootIdentity, root))) throw new Error('Cannot verify owned Electron root');
    this.rootIdentity ??= root;
    for (const [pid, identity] of ownedProcessTree(table, root)) this.identities.set(pid, identity);
  }

  async waitForExit(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.identities.size) this.identities = remainingIdentities(this.identities, await processTable());
      if (!this.identities.size && this.exited) return;
      if (Date.now() >= deadline) throw new Error(`Electron processes did not exit: ${[...this.identities.keys()].join(', ')}`);
      await delay(100);
    }
  }

  async crash() {
    await this.capture();
    // No app.quit(): startup recovery must observe abrupt shutdown. Each kill
    // checks birth identity again; captured PID numbers alone are insufficient.
    const root = this.identities.get(this.child.pid);
    if (root) await forceKill(root);
    for (const [pid, identity] of this.identities) if (pid !== this.child.pid) await forceKill(identity);
    await this.waitForExit();
    await withTimeout(() => this.application.close(), 5_000, 'Disconnect crashed Electron');
  }

  async close() {
    await this.capture();
    try {
      await withTimeout(() => this.application.close(), 5_000, 'Close Electron');
      await this.waitForExit(2_000);
    } catch {
      // An active task may cancel app.quit() with a modal dialog.
      await this.crash();
    }
  }
}

export async function cleanupDesktopSmoke(instances, userData, warn, remove = rm) {
  for (const instance of instances) {
    try { await instance.close(); }
    catch (error) { warn('Could not stop smoke Electron instance', error); }
  }
  try { await remove(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { warn(`Could not remove smoke userData ${userData}`, error); }
}
