import { ipcMain } from 'electron';
import type { ReviewMode } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

/** Serialize full and mode-only edits together, resolving protected paths at commit time. */
export function registerHostSafetyIpc(state: AppState, runtime: RuntimeBridge): void {
  const pending = new Map<string, Promise<void>>();
  function update(hostId: string, mode: ReviewMode, protectedPaths?: string[]): Promise<void> {
    if (!['ask', 'ai-review', 'permissive'].includes(mode) || (protectedPaths !== undefined
      && (!Array.isArray(protectedPaths) || protectedPaths.some((value) => typeof value !== 'string'
        || !value.startsWith('/') || value.includes('\u0000'))))) return Promise.reject(new Error('Invalid safety settings'));
    const paths = protectedPaths?.slice();
    const work = (pending.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const host = state.getHost(hostId);
      if (host.archived) throw new Error('主机已归档，无法修改权限');
      const revision = host.policyRevision + 1;
      const nextPaths = paths ?? [...host.protectedPaths];
      await runtime.call({ method: 'update-host-safety', hostId, mode, protectedPaths: nextPaths, revision });
      state.updateHost(hostId, { defaultMode: mode, protectedPaths: nextPaths, policyRevision: revision });
    });
    pending.set(hostId, work);
    void work.finally(() => { if (pending.get(hostId) === work) pending.delete(hostId); }).catch(() => undefined);
    return work;
  }
  ipcMain.handle('cloudhelm:update-host-safety', (_event, id: string, mode: ReviewMode, paths: string[]) => {
    if (!Array.isArray(paths)) throw new Error('Invalid safety settings');
    return update(id, mode, paths);
  });
  ipcMain.handle('cloudhelm:update-host-review-mode', (_event, id: string, mode: ReviewMode) => update(id, mode));
}
