interface ProfileApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** Call after setting userData, before opening its database or starting recovery. */
export function acquireProfileLock(app: ProfileApplication, activate: () => void): boolean {
  let owned: boolean;
  try { owned = app.requestSingleInstanceLock(); }
  catch { throw new Error('无法锁定本地数据目录，未打开数据库。'); }
  if (!owned) { app.quit(); return false; }
  // Never interpret or log another process's command line or additional data.
  app.on('second-instance', () => activate());
  // Electron retains the lock until process exit; do not release before closing storage.
  return true;
}
