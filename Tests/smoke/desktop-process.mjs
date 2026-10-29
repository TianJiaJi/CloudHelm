import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function withTimeout(action, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function processTable() {
  // Query ancestry, never select processes by executable name: other Electron apps may be open.
  // Loaded CI runners can exceed the query budget or fail it transiently; retry before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = process.platform === 'win32'
        ? await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'],
        { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        : await execute('ps', ['-axo', 'pid=,ppid=,stat='], { timeout: 30_000 });
      return stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
        const [pid, parentPid, state = ''] = line.trim().split(/\s+/u);
        return { pid: Number(pid), parentPid: Number(parentPid), zombie: state.startsWith('Z') };
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(250 * attempt);
    }
  }
}

function descendants(table, root) {
  const pids = new Set([root]);
  let size;
  do {
    size = pids.size;
    for (const entry of table) if (pids.has(entry.parentPid)) pids.add(entry.pid);
  } while (size !== pids.size);
  return pids;
}

export async function forceKill(pid) {
  // Best-effort termination; waitForExit() is the authoritative exit check below.
  // Kill only captured PIDs. Windows taskkill /T can reject an orphan after its
  // parent exits; Node's SIGKILL terminates that PID without walking ancestry.
  // Windows reports EPERM for a PID that already exited but is not yet reaped
  // (POSIX reports ESRCH), and a process can disappear between the snapshot and
  // termination, so both codes mean "already gone or racy to observe" and are
  // tolerated here; a process that really survives still fails waitForExit().
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

/** Owns only one isolated smoke instance, including descendants orphaned by a crash. */
export class DesktopProcess {
  constructor(application) {
    this.application = application;
    this.child = application.process();
    if (!Number.isSafeInteger(this.child.pid) || this.child.pid <= 0) throw new Error('Electron has no valid PID');
    this.pids = new Set([this.child.pid]);
  }

  async capture() {
    const table = await processTable();
    // Forget already exited processes so an old PID is not kept across smoke stages.
    const live = new Set(table.filter((entry) => !entry.zombie).map((entry) => entry.pid));
    this.pids = new Set([...this.pids].filter((pid) => live.has(pid)));
    if (this.child.exitCode === null && this.child.signalCode === null && live.has(this.child.pid)) {
      for (const pid of descendants(table, this.child.pid)) this.pids.add(pid);
    }
  }

  async waitForExit(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = (await processTable()).filter((entry) => this.pids.has(entry.pid) && !entry.zombie);
      if (!remaining.length && (this.child.exitCode !== null || this.child.signalCode !== null)) {
        this.pids.clear();
        return;
      }
      if (Date.now() >= deadline) throw new Error(`Electron processes did not exit: ${remaining.map((entry) => entry.pid).join(', ')}`);
      await delay(100);
    }
  }

  async crash() {
    await this.capture();
    // No app.quit()/close(): the persisted pending question must reach startup recovery.
    if (this.pids.has(this.child.pid)) await forceKill(this.child.pid);
    // Terminating one PID does not kill descendants; include captured orphans.
    const live = new Set((await processTable()).filter((entry) => !entry.zombie).map((entry) => entry.pid));
    for (const pid of this.pids) if (pid !== this.child.pid && live.has(pid)) await forceKill(pid);
    // OS process termination releases userData/SQLite handles before we reuse the directory.
    await this.waitForExit();
    await withTimeout(() => this.application.close(), 5_000, 'Disconnect crashed Electron');
  }

  async close() {
    await this.capture();
    try {
      await withTimeout(() => this.application.close(), 5_000, 'Close Electron');
      await this.waitForExit(2_000);
    } catch {
      // An active task may cancel app.quit() with a modal dialog, including on test failure.
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
