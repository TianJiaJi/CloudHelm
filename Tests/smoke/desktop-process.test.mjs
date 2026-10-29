import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { DesktopProcess, cleanupDesktopSmoke, forceKill, withTimeout } from './desktop-process.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-process-test-'));
  const file = path.join(directory, 'held-open');
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
      require('node:fs').openSync(${JSON.stringify(file)}, 'w');
      process.send(process.pid);
      setInterval(() => {}, 1000);
    `)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', (pid) => process.send(pid));
    process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'graceful'))}, 'graceful'));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const [descendantPid] = await withTimeout(() => once(child, 'message'), 10_000, 'Fixture startup');
  const application = { process: () => child, close: vi.fn(async () => {}) };
  return { directory, child, descendantPid, application, guard: new DesktopProcess(application) };
}

describe('desktop smoke process lifecycle', () => {
  it('crashes the owned tree, releases its files, and leaves an unrelated process alive', async () => {
    const value = await fixture();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await value.guard.crash();
      expect(value.child.exitCode !== null || value.child.signalCode !== null).toBe(true);
      expect(() => process.kill(value.descendantPid, 0)).toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      await expect(readFile(path.join(value.directory, 'graceful'))).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(value.directory, { recursive: true });
    } finally {
      unrelated.kill('SIGKILL');
      await value.guard.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('forces termination when graceful close fails with an active task', async () => {
    const value = await fixture();
    value.application.close.mockRejectedValueOnce(new Error('quit canceled'));
    try {
      await value.guard.close();
      expect(value.child.exitCode !== null || value.child.signalCode !== null).toBe(true);
      expect(() => process.kill(value.descendantPid, 0)).toThrow();
    } finally {
      await value.guard.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('removes captured orphans even when the Electron main process already exited', async () => {
    const value = await fixture();
    try {
      await value.guard.capture();
      const exited = once(value.child, 'exit');
      value.child.kill('SIGKILL');
      await exited;
      await value.guard.crash();
      expect(() => process.kill(value.descendantPid, 0)).toThrow();
    } finally {
      await value.guard.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('bounds a hung close without leaving its timeout running', async () => {
    await expect(withTimeout(() => new Promise(() => {}), 20, 'Close Electron')).rejects.toThrow('Close Electron timed out');
    await expect(withTimeout(() => Promise.resolve('closed'), 1000, 'Close Electron')).resolves.toBe('closed');
  });

  it('tolerates EPERM like ESRCH for an already-exited PID and keeps unexpected errors', async () => {
    // Windows reports EPERM instead of ESRCH for a PID that already exited but is
    // not yet reaped; waitForExit() still proves whether anything survived.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    try {
      await expect(forceKill(4242)).resolves.toBeUndefined();
      kill.mockImplementation(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });
      await expect(forceKill(4242)).resolves.toBeUndefined();
      kill.mockImplementation(() => { throw Object.assign(new Error('kill UNKNOWN'), { code: 'UNKNOWN' }); });
      await expect(forceKill(4242)).rejects.toThrow('kill UNKNOWN');
    } finally { kill.mockRestore(); }
  });

  it('cleans up when graceful close never resolves', async () => {
    const value = await fixture();
    value.application.close.mockImplementationOnce(() => new Promise(() => {}));
    try {
      await value.guard.close();
      expect(value.child.exitCode !== null || value.child.signalCode !== null).toBe(true);
      expect(() => process.kill(value.descendantPid, 0)).toThrow();
    } finally {
      await value.guard.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports cleanup errors without replacing the test failure and still removes userData', async () => {
    const warning = vi.fn();
    const closeError = new Error('close failed');
    const lockError = Object.assign(new Error('locked'), { code: 'EBUSY' });
    const remove = vi.fn().mockRejectedValue(lockError);
    const original = new Error('firstWindow failed');
    async function failedSmoke() {
      try { throw original; }
      finally {
        await cleanupDesktopSmoke([{ close: async () => { throw closeError; } }], 'temporary-user-data', warning, remove);
      }
    }
    await expect(failedSmoke()).rejects.toBe(original);
    expect(remove).toHaveBeenCalledWith('temporary-user-data', expect.objectContaining({ recursive: true, maxRetries: 10 }));
    expect(warning).toHaveBeenCalledWith('Could not stop smoke Electron instance', closeError);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('temporary-user-data'), lockError);
  });
});
