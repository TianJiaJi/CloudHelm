import { rm } from 'node:fs/promises';

export type SessionDirectoryCleanupResult = { status: 'removed' } | {
  status: 'failed'; reason: 'permission-denied' | 'busy' | 'io-error';
};

/** Owns one mkdtemp directory only, never the durable conversation storage.
 * Duplicate disposal shares a single deletion. Node's finite retries handle
 * Windows transient locks; a final failure is reported without paths/content.
 */
export function sessionDirectoryCleanup(directory: string, remove: typeof rm = rm,
  report: (reason: string) => void = (reason) => process.emitWarning(`CloudHelm temporary session directory cleanup failed (${reason})`,
    { code: 'CLOUDHELM_SESSION_CLEANUP_FAILED' })): () => Promise<SessionDirectoryCleanupResult> {
  let pending: Promise<SessionDirectoryCleanupResult> | undefined;
  return () => pending ??= Promise.resolve().then(() => remove(directory,
    { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })).then(
    () => ({ status: 'removed' as const }),
    (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const reason = code === 'EPERM' || code === 'EACCES' ? 'permission-denied' as const
        : code === 'EBUSY' || code === 'ENOTEMPTY' ? 'busy' as const : 'io-error' as const;
      report(reason);
      return { status: 'failed' as const, reason };
    });
}
