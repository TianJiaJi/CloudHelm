import { ipcMain } from 'electron';
import type { ReviewMode } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

/** Serialize host defaults and path edits; the worker owns live approvals. */
export function registerHostSafetyIpc(state: AppState, runtime: RuntimeBridge): void {
  const pending = new Map<string, Promise<void>>();
  const validPaths = (paths: string[] | undefined) => paths === undefined || (Array.isArray(paths)
    && paths.every((value) => typeof value === 'string' && value.startsWith('/') && !value.includes('\u0000')));
  function update(hostId: string, mode: ReviewMode, protectedReadPaths?: string[], protectedWritePaths?: string[]): Promise<void> {
    if (!['ask', 'ai-review', 'permissive'].includes(mode) || !validPaths(protectedReadPaths) || !validPaths(protectedWritePaths)) {
      return Promise.reject(new Error('Invalid safety settings'));
    }
    const reads = protectedReadPaths?.slice();
    const writes = protectedWritePaths?.slice();
    const work = (pending.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const host = state.getHost(hostId);
      if (host.archived) throw new Error('主机已归档，无法修改权限');
      const revision = host.policyRevision + 1;
      const nextReads = reads ?? [...(host.protectedReadPaths ?? host.protectedPaths)];
      const nextWrites = writes ?? [...(host.protectedWritePaths ?? host.protectedPaths)];
      await runtime.call({ method: 'update-host-safety', hostId, mode, protectedReadPaths: nextReads,
        protectedWritePaths: nextWrites, revision });
      state.updateHost(hostId, { defaultMode: mode, protectedReadPaths: nextReads,
        protectedWritePaths: nextWrites, protectedPaths: [...new Set([...nextReads, ...nextWrites])], policyRevision: revision });
    });
    pending.set(hostId, work);
    void work.finally(() => { if (pending.get(hostId) === work) pending.delete(hostId); }).catch(() => undefined);
    return work;
  }
  ipcMain.handle('cloudhelm:update-host-safety', (_event, id: string, mode: ReviewMode, reads: string[], writes: string[]) => {
    if (!Array.isArray(reads) || !Array.isArray(writes)) throw new Error('Invalid safety settings');
    return update(id, mode, reads, writes);
  });
  ipcMain.handle('cloudhelm:update-host-review-mode', (_event, id: string, mode: ReviewMode) => update(id, mode));
  ipcMain.handle('cloudhelm:update-conversation-review-mode', async (_event, taskId: string, hostId: string, mode: ReviewMode) => {
    if (!['ask', 'ai-review', 'permissive'].includes(mode)) throw new Error('Invalid review mode');
    const task = state.getTask(taskId);
    if (!task.hostIds.includes(hostId)) throw new Error('主机不属于当前对话');
    const revision = (task.reviewRevision ?? 1) + 1;
    if (await runtime.call<boolean>({ method: 'has-task', taskId })) {
      await runtime.call({ method: 'update-conversation-review-mode', taskId, hostId, mode, revision });
    }
    state.updateConversationReviewMode(taskId, hostId, mode);
  });
}
