import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { forceKill, ownedProcessTree, processTable, remainingIdentities } from './desktop-process-identity.mjs';
import { withTimeout } from './desktop-process.mjs';

const entry = (pid, parentPid, birth, zombie = false) => ({ pid, parentPid, birth, zombie });
describe('smoke process identity authority', () => {
  it('rejects historical descendants of a recycled parent PID, including their subtree', () => {
    const root = entry(100, 1, '200');
    const oldChild = entry(200, 100, '100'), oldGrandchild = entry(300, 200, '110');
    const child = entry(400, 100, '210'), grandchild = entry(500, 400, '220');
    // Deliberately out of order: ownership must be a temporal chain, not a PID closure.
    const owned = ownedProcessTree([oldGrandchild, grandchild, oldChild, root, child], root);
    expect([...owned.keys()].sort()).toEqual([100, 400, 500]);
  });
  it('allows equal timestamp precision for genuine descendants', () => {
    const root = entry(100, 1, '200');
    expect([...ownedProcessTree([root, entry(200, 100, '200')], root).keys()]).toEqual([100, 200]);
  });
  it('drops a recycled PID instead of keeping termination or liveness authority', () => {
    const child = entry(200, 100, '210');
    expect(remainingIdentities(new Map([[child.pid, child]]), [entry(200, 999, '900')]).size).toBe(0);
  });
  it('retains a known orphan with unchanged birth identity', () => {
    const child = entry(200, 100, '210');
    expect(remainingIdentities(new Map([[child.pid, child]]), [entry(200, 1, '210')]).get(200)).toEqual(child);
  });
  it('treats missing identity as uncertainty, not proof of exit', () => {
    const root = entry(100, 1, '200');
    expect(() => ownedProcessTree([root, entry(200, 100, '?')], root)).toThrow('Cannot verify');
    expect(() => remainingIdentities(new Map([[100, root]]), [entry(100, 1, '?')])).toThrow('Cannot verify');
  });
  it('does not retain disappeared or zombie identities', () => {
    const root = entry(100, 1, '200');
    expect(remainingIdentities(new Map([[100, root]]), []).size).toBe(0);
    expect(remainingIdentities(new Map([[100, root]]), [{ ...root, zombie: true }]).size).toBe(0);
  });
  it('treats a confirmed exited identity as an idempotent successful cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let identity;
    try {
      await withTimeout(() => once(child, 'spawn'), 5000, 'Exited fixture spawn');
      identity = (await processTable()).find((value) => value.pid === child.pid);
      expect(identity).toBeDefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit'); child.kill('SIGKILL');
        await withTimeout(() => exit, 5000, 'Exited fixture termination');
      }
    }
    await expect(forceKill(identity)).resolves.toBeUndefined();
  }, 30_000);
  it('rechecks birth identity at actual termination and leaves the mismatched owned fixture alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await withTimeout(() => once(child, 'spawn'), 5000, 'Identity fixture spawn');
      const identity = (await processTable()).find((value) => value.pid === child.pid);
      expect(identity).toBeDefined();
      await forceKill({ ...identity, birth: String(BigInt(identity.birth) + 10n) });
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit'); child.kill('SIGKILL');
        await withTimeout(() => exit, 5000, 'Identity fixture exit');
      }
    }
  }, 30_000);
});
