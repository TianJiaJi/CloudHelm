import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileAttributeDigest, fileMetadataDigest,
  type FileEditCommit, type FileInspection, type ProposedOperation, type RecoveryCleanupResult, type RecoveryEntry } from '@cloudhelm/core';

export type FileOperation = Extract<ProposedOperation, { kind: 'write-file' | 'inspect-file' | 'list-recovery' | 'cleanup-recovery' }>;
export type FileAction = 'inspect' | 'inspect-backup' | 'apply' | 'restore' | 'list-recovery' | 'cleanup-recovery';
export interface FileDriverReply { status: 'inspected' | 'committed' | 'listed' | 'cleaned' | 'refused' | 'unknown';
  snapshot?: FileInspection; recovery?: FileRecoveryLike; entries?: RecoveryEntry[]; truncated?: boolean; items?: RecoveryCleanupResult[];
  code?: string; effects?: 'none' | 'possible'; authenticationFailed?: boolean }
interface FileRecoveryLike { version: 1; directoryId: string; path: string;
  beforeSha256: string; beforeMetadataDigest: string; afterSha256: string; afterMetadataDigest: string }
export const FILE_MAX_BYTES = 1_048_576;
export const quote = (text: string) => `'${text.replace(/'/gu, `'"'"'`)}'`;
export const sha256hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const refused = (code: string): FileDriverReply => ({ status: 'refused', effects: 'none', code });
export const unknownPossible = (code: string): FileDriverReply => ({ status: 'unknown', effects: 'possible', code });

/** Absolute, normalized, control-free path only; never a directory or the root. */
export function validRemoteFilePath(target: string): boolean {
  return typeof target === 'string' && target.length <= 4096 && target.startsWith('/') && !target.startsWith('//')
    && !/[\u0000-\u001f\u007f]/u.test(target) && path.posix.normalize(target) === target
    && !target.split('/').includes('.') && !target.split('/').includes('..');
}

export function fileActionOf(operation: FileOperation): FileAction | undefined {
  return operation.kind === 'inspect-file' ? operation.recoveryDirectoryId ? 'inspect-backup' : 'inspect'
    : operation.kind === 'list-recovery' ? 'list-recovery'
    : operation.kind === 'cleanup-recovery' ? 'cleanup-recovery'
    : operation.fileEdit?.action;
}

/** Local refusal inside one route; effects are none unless the caller already published. */
export class FileRefused extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** Builds the v2 snapshot: complete UTF-8 only, digests computed locally. */
export function buildInspection(input: {
  path: string; bytes: Buffer; executionUid: number; uid: number; gid: number; mode: number; mtimeSec: number;
}): FileInspection {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length > FILE_MAX_BYTES
    || !Number.isSafeInteger(input.uid) || !Number.isSafeInteger(input.gid) || !Number.isSafeInteger(input.mode)
    || input.mode < 0 || input.mode > 0o7777 || !Number.isSafeInteger(input.mtimeSec) || input.mtimeSec < 0) throw new Error('Invalid inspection input');
  const content = input.bytes.toString('utf8');
  if (!Buffer.from(content).equals(input.bytes) || content.includes('\0')) throw new FileRefused('not-complete-utf8-text');
  const special = (input.mode & 0o7000) !== 0;
  const ownership = input.uid !== input.executionUid;
  return { version: 2, path: input.path, content, sha256: sha256hex(input.bytes),
    metadataDigest: fileMetadataDigest({ size: input.bytes.length, mode: input.mode, uid: input.uid, gid: input.gid, mtimeSec: input.mtimeSec }),
    attributeDigest: fileAttributeDigest({ uid: input.uid, gid: input.gid, mode: input.mode }),
    executionUid: input.executionUid, uid: input.uid, gid: input.gid, mode: input.mode, size: input.bytes.length,
    commitSupported: !special && !ownership,
    limitation: special ? 'special-permission-bits-require-manual-handling' : ownership ? 'ownership-preservation-unavailable' : '' };
}

export function validEditFor(action: FileAction, edit: FileEditCommit | undefined): edit is FileEditCommit {
  return !!edit && (action === 'apply' || action === 'restore') && edit.action === action;
}

/** The backup file naming shared by both routes and the executor's location hint. */
export function recoveryBackupPath(directoryPath: string, fileName: string, transactionId: string): string {
  return path.posix.join(directoryPath, `${fileName}.cloudhelm-backup-${transactionId}`);
}
