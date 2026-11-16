export interface FileInspection {
  version: 1; path: string; content: string; sha256: string; metadataDigest: string; attributeDigest: string;
  executionUid: number; uid: number; gid: number; mode: number; size: number;
  device: string; inode: string; commitSupported: boolean; limitation: string;
}
export interface FileEditCommit {
  version: 1; action: 'apply' | 'restore'; transactionId: string;
  expectedMetadataDigest: string; expectedAttributeDigest: string; expectedExecutionUid: number; diff: string;
  backupTransactionId?: string; expectedBackupMetadataDigest?: string;
}
/** Bounded non-secret receipt; the backup is inside a private 0700 directory.
 * A receipt is not permission: restoration requires a new exact reviewed operation. */
export interface FileRecovery {
  version: 1; directoryId: string; path: string;
  beforeSha256: string; beforeMetadataDigest: string; afterSha256: string; afterMetadataDigest: string;
}
export const FILE_TRANSACTION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const FILE_TRANSACTION_HASH = /^[a-f0-9]{64}$/u;
/** Private recovery material names: exactly the staged edit directory or the
 * delete-time content backup. Anything else is never removal candidate. */
export const RECOVERY_DIRECTORY_NAME = /^\.cloudhelm-edit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const RECOVERY_BACKUP_NAME = /^[^\u0000-\u001f\u007f/]{1,201}\.cloudhelm-backup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function validRecoveryEntryName(name: string): boolean {
  return typeof name === 'string' && name.length <= 255
    && (RECOVERY_DIRECTORY_NAME.test(name) || RECOVERY_BACKUP_NAME.test(name));
}
/** One bounded listing row; metadata only, never content or an approval. */
export interface RecoveryEntry { name: string; kind: 'edit-directory' | 'backup-file'; size: number; mtimeMs: number }
/** Per-name cleanup receipt; refused/missing are definitive outcomes, not unknowns. */
export interface RecoveryCleanupResult { name: string; result: 'removed' | 'missing' | 'refused'; code?: string }
export function validFileEditCommit(edit: FileEditCommit): boolean {
  return edit?.version === 1 && ['apply', 'restore'].includes(edit.action)
    && FILE_TRANSACTION_UUID.test(edit.transactionId) && FILE_TRANSACTION_HASH.test(edit.expectedMetadataDigest)
    && FILE_TRANSACTION_HASH.test(edit.expectedAttributeDigest)
    && typeof edit.diff === 'string' && Buffer.byteLength(edit.diff) <= 65_536
    && Object.keys(edit).every((key) => ['version', 'action', 'transactionId', 'expectedMetadataDigest', 'expectedAttributeDigest', 'expectedExecutionUid', 'diff', 'backupTransactionId', 'expectedBackupMetadataDigest'].includes(key))
    && Number.isSafeInteger(edit.expectedExecutionUid) && edit.expectedExecutionUid >= 0
    && (edit.action === 'apply' ? edit.backupTransactionId === undefined && edit.expectedBackupMetadataDigest === undefined
      : FILE_TRANSACTION_UUID.test(edit.backupTransactionId ?? '') && FILE_TRANSACTION_HASH.test(edit.expectedBackupMetadataDigest ?? ''));
}
