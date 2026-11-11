import { execFile } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function validIdentity(value) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0
    && typeof value.birth === 'string' && /^\d{1,19}$/u.test(value.birth);
}
export function sameIdentity(a, b) { return validIdentity(a) && validIdentity(b) && a.pid === b.pid && a.birth === b.birth; }

export async function processTable() {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = process.platform === 'win32'
        ? await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { ' +
          '$birth="?"; if ($null -ne $_.CreationDate) { $birth=$_.CreationDate.ToUniversalTime().Ticks.ToString() }; ' +
          '"{0} {1} {2}" -f $_.ProcessId,$_.ParentProcessId,$birth }'],
        { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        : await execute('ps', ['-axo', 'pid=,ppid=,stat=,lstart='],
          { timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
      return stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
        const [pid, parentPid, third, ...date] = line.trim().split(/\s+/u);
        const birth = process.platform === 'win32' ? third : String(Date.parse(date.join(' ')));
        if (!Number.isSafeInteger(Number(pid)) || !Number.isSafeInteger(Number(parentPid))) throw new Error('Invalid process table');
        return { pid: Number(pid), parentPid: Number(parentPid), birth, zombie: process.platform !== 'win32' && third.startsWith('Z') };
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(250 * attempt);
    }
  }
}

/** A recycled parent PID does not make older processes descendants of the new owner. */
export function ownedProcessTree(table, root) {
  if (!validIdentity(root)) throw new Error('Cannot verify root process identity');
  const owned = new Map([[root.pid, root]]);
  let size;
  do {
    size = owned.size;
    for (const entry of table) {
      const parent = owned.get(entry.parentPid);
      if (!parent || entry.zombie || owned.has(entry.pid)) continue;
      if (!validIdentity(entry)) throw new Error('Cannot verify descendant process identity');
      if (BigInt(entry.birth) >= BigInt(parent.birth)) owned.set(entry.pid, entry);
    }
  } while (size !== owned.size);
  return owned;
}

export function remainingIdentities(owned, table) {
  const current = new Map(table.map((entry) => [entry.pid, entry]));
  return new Map([...owned].filter(([pid, identity]) => {
    const entry = current.get(pid);
    if (!entry || entry.zombie) return false;
    if (!validIdentity(entry)) throw new Error('Cannot verify captured process identity');
    return sameIdentity(identity, entry);
  }));
}

/** Never accept a bare PID as termination authority. */
export async function forceKill(identity) {
  if (!validIdentity(identity)) throw new Error('Tracked process identity required');
  if (process.platform === 'win32') {
    // Pin the native handle before reading StartTime. Kill through that same
    // Process instance, not a fresh PID lookup after validation. CIM dates have
    // microsecond precision, so truncate native 100ns ticks (without doubles).
    const script = `$ErrorActionPreference='Stop'; $p=$null; try { ` +
      `try { $p=[System.Diagnostics.Process]::GetProcessById(${identity.pid}) } catch [System.ArgumentException] { exit 0 }; ` +
      `$null=$p.Handle; $ticks=$p.StartTime.ToUniversalTime().Ticks; ` +
      `if (($ticks-($ticks%10)).ToString() -cne '${identity.birth}') { exit 0 }; $p.Kill() ` +
      `} catch [System.InvalidOperationException] { exit 0 } finally { if ($null -ne $p) { $p.Dispose() } }; exit 0`;
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true });
    return;
  }
  // POSIX revalidation narrows PID reuse but is not pidfd-based atomic killing.
  // Linux/macOS packaged smoke validation remains a separate acceptance item.
  const current = (await processTable()).find((entry) => entry.pid === identity.pid);
  if (!current || current.zombie) return;
  if (!validIdentity(current)) throw new Error('Cannot verify process before termination');
  if (!sameIdentity(current, identity)) return;
  try { process.kill(identity.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
