import type { ConversationCleanup, SqliteStore } from '@cloudhelm/adapters';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

type CleanupStore = Pick<SqliteStore, 'get' | 'list' | 'remove'>;
const statIfPresent = (path: string) => lstat(path).catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
  throw error;
});
/** Records have already committed. Failure keeps the redo receipt, never resurrects a task. */
export async function finishConversationCleanup(store: CleanupStore, sessionRoot: string, taskId: string,
  removeDirectory: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true })): Promise<boolean> {
  const value = store.get<ConversationCleanup>('conversation-cleanups', taskId);
  if (value === undefined) return true;
  if (!value || value.version !== 1 || value.taskId !== taskId || store.get('tasks', taskId)
    || (value.sessionId !== undefined && (value.sessionId !== taskId || !/^[a-zA-Z0-9-]{1,120}$/u.test(value.sessionId)))) {
    throw new Error('Invalid conversation cleanup ownership');
  }
  try {
    if (value.sessionId !== undefined) {
      const root = await statIfPresent(sessionRoot);
      if (root && (!root.isDirectory() || root.isSymbolicLink())) return false;
      const path = join(sessionRoot, value.sessionId);
      const stats = root ? await statIfPresent(path) : undefined;
      // Never traverse a root replaced with a symlink/junction or another object type.
      if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) return false;
      if (stats) await removeDirectory(path);
    }
    store.remove('conversation-cleanups', taskId);
    return true;
  } catch {
    // Native errors may include private paths. Only the durable pending outcome crosses IPC/logging.
    return false;
  }
}

/** Retry after startup without delaying the window or requesting SSH/model capabilities. */
export async function resumeConversationCleanup(store: CleanupStore, sessionRoot: string): Promise<number> {
  let pending = 0;
  for (const value of store.list<ConversationCleanup>('conversation-cleanups')) {
    try { if (!await finishConversationCleanup(store, sessionRoot, value?.taskId)) pending++; }
    catch { pending++; }
  }
  return pending;
}
