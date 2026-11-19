import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { fileAttributeDigest, fileMetadataDigest, RECOVERY_DIRECTORY_NAME, validRecoveryEntryName,
  type FileEditCommit, type RecoveryCleanupResult, type RecoveryEntry } from '@cloudhelm/core';
import { readBoundedSftpFile } from './sftp-read.js';
import type { FileCommandOutcome } from './file-native-command.js';
import { buildInspection, FILE_MAX_BYTES, FileRefused, quote, recoveryBackupPath, refused, sha256hex,
  unknownPossible, validEditFor, validRemoteFilePath,
  type FileAction, type FileDriverReply, type FileOperation } from './file-transaction-protocol.js';

/** Route A context: the runner supplies the probed execution identity, an SFTP
 * scope and a literal native command runner; this module never touches the
 * transport and never authors command text beyond the quoted literals. */
export interface SftpTransactionContext {
  operation: FileOperation; action: FileAction; edit?: FileEditCommit; transactionId: string; executionUid: number;
  sftp: <T>(work: (sftp: SFTPWrapper, assertActive: () => void) => Promise<T>) => Promise<T>;
  runCommand: (command: string, timeoutMs?: number) => Promise<FileCommandOutcome>;
}

const lstatOptional = (sftp: SFTPWrapper, remotePath: string): Promise<Stats | undefined> =>
  new Promise((resolve, reject) => sftp.lstat(remotePath, (error, stat) => {
    if (!error) resolve(stat);
    else if ('code' in error && error.code === 2) resolve(undefined);
    else reject(error);
  }));
const unlinkOptional = (sftp: SFTPWrapper, remotePath: string): Promise<void> =>
  new Promise((resolve, reject) => sftp.unlink(remotePath, (error) => error ? reject(error) : resolve()));
const rmdirOptional = (sftp: SFTPWrapper, remotePath: string): Promise<void> =>
  new Promise((resolve, reject) => sftp.rmdir(remotePath, (error) => error ? reject(error) : resolve()));
const mkdirExclusive = (sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> =>
  new Promise((resolve, reject) => sftp.mkdir(remotePath, { mode }, (error) => error ? reject(error) : resolve()));
const writeFileExclusive = (sftp: SFTPWrapper, remotePath: string, content: Buffer, mode: number): Promise<void> =>
  new Promise((resolve, reject) => sftp.writeFile(remotePath, content, { mode, flag: 'wx' }, (error) => error ? reject(error) : resolve()));
const setstat = (sftp: SFTPWrapper, remotePath: string, attrs: { uid: number; gid: number; mode: number }): Promise<void> =>
  new Promise((resolve, reject) => sftp.setstat(remotePath, attrs, (error) => error ? reject(error) : resolve()));
const readdir = (sftp: SFTPWrapper, remotePath: string): Promise<{ filename: string; attrs: Stats }[]> =>
  new Promise((resolve, reject) => sftp.readdir(remotePath, (error, list) => error ? reject(error) : resolve(list ?? [])));
const statDigest = (stat: Stats): string =>
  fileMetadataDigest({ size: stat.size, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, mtimeSec: stat.mtime });
const attributeDigestOf = (stat: Stats): string =>
  fileAttributeDigest({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 });

/** Every ancestor must be a real directory, never a symlink. */
async function walkParents(sftp: SFTPWrapper, directory: string): Promise<void> {
  const parts = path.posix.normalize(directory).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    const stat = await lstatOptional(sftp, current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new FileRefused('unsafe-parent-directory');
  }
}

/** Bounded read of one regular file; size/type re-checked against the live stat. */
async function readLive(sftp: SFTPWrapper, target: string, maxBytes: number): Promise<{ stat: Stats; bytes: Buffer }> {
  const stat = await lstatOptional(sftp, target);
  if (!stat) throw new FileRefused('file-missing');
  if (!stat.isFile() || stat.isSymbolicLink()) throw new FileRefused('not-a-bounded-single-link-file');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw new FileRefused('file-too-large');
  const bytes = await readBoundedSftpFile(sftp, target, maxBytes, () => {});
  if (bytes.length !== stat.size) throw new FileRefused('source-changed-during-read');
  return { stat, bytes };
}

/** Route A: client-side SFTP transaction with literal ln/mv commit commands.
 * A local FileRefused is a definitive effects:none refusal unless the caller
 * already published; transport failures propagate to the runner's unknown path. */
export async function sftpFileTransaction(context: SftpTransactionContext): Promise<FileDriverReply> {
  try {
    switch (context.action) {
      case 'inspect': return await inspectTarget(context);
      case 'inspect-backup': return await inspectBackupTarget(context);
      case 'apply': return await applyTransaction(context);
      case 'restore': return await restoreTransaction(context);
      case 'list-recovery': return await listRecovery(context);
      case 'cleanup-recovery': return await cleanupRecovery(context);
    }
  } catch (error) {
    // Read-only and listing refusals are definitive local outcomes; transport
    // failures propagate so the runner can classify effects conservatively.
    if (error instanceof FileRefused) return refused(error.code);
    throw error;
  }
  return refused('invalid-action');
}

async function inspectTarget(context: SftpTransactionContext): Promise<FileDriverReply> {
  if (!validRemoteFilePath(context.operation.path)) return refused('invalid-path');
  return context.sftp(async (sftp) => {
    await walkParents(sftp, path.posix.dirname(context.operation.path));
    const live = await readLive(sftp, context.operation.path, FILE_MAX_BYTES);
    return { status: 'inspected',
      snapshot: buildInspection({ path: context.operation.path, bytes: live.bytes, executionUid: context.executionUid,
        uid: live.stat.uid, gid: live.stat.gid, mode: live.stat.mode & 0o7777, mtimeSec: live.stat.mtime }) };
  });
}

async function inspectBackupTarget(context: SftpTransactionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  const recoveryDirectoryId = operation.kind === 'inspect-file' ? operation.recoveryDirectoryId : undefined;
  if (operation.kind !== 'inspect-file' || !validRemoteFilePath(operation.path) || !recoveryDirectoryId) return refused('invalid-path');
  return context.sftp(async (sftp) => {
    await walkParents(sftp, path.posix.dirname(operation.path));
    const backup = recoveryBackupPath(path.posix.dirname(operation.path), path.posix.basename(operation.path), recoveryDirectoryId);
    const live = await readLive(sftp, backup, FILE_MAX_BYTES);
    return { status: 'inspected',
      snapshot: buildInspection({ path: operation.path, bytes: live.bytes, executionUid: context.executionUid,
        uid: live.stat.uid, gid: live.stat.gid, mode: live.stat.mode & 0o7777, mtimeSec: live.stat.mtime }) };
  });
}

/** Best-effort removal of uncommitted artifacts. The caller proceeds only when
 * every artifact is verifiably gone; any leftover turns the reply unknown. */
async function cleanupArtifacts(context: SftpTransactionContext, artifacts: { staging?: string; entry?: string; backup?: string }): Promise<void> {
  await context.sftp(async (sftp) => {
    if (artifacts.entry) await unlinkOptional(sftp, artifacts.entry).catch((error) => { if (!('code' in error && error.code === 2)) throw error; });
    if (artifacts.backup) await unlinkOptional(sftp, artifacts.backup).catch((error) => { if (!('code' in error && error.code === 2)) throw error; });
    if (artifacts.staging) {
      await rmdirOptional(sftp, artifacts.staging).catch((error) => { if (!('code' in error && error.code === 2)) throw error; });
      if (await lstatOptional(sftp, artifacts.staging)) throw new Error('staging directory remains');
    }
  });
}

/** Final publication check for apply/restore: regular target, exact approved
 * content hash and the approved attribute digest. */
async function verifyPublished(context: SftpTransactionContext, expectedSha256: string, expectedAttributeDigest: string): Promise<{ stat: Stats; bytes: Buffer }> {
  return context.sftp(async (sftp) => {
    const after = await readLive(sftp, context.operation.path, FILE_MAX_BYTES);
    if (sha256hex(after.bytes) !== expectedSha256) throw new FileRefused('read-back-mismatch');
    if (attributeDigestOf(after.stat) !== expectedAttributeDigest) throw new FileRefused('read-back-mismatch');
    return after;
  });
}

async function applyTransaction(context: SftpTransactionContext): Promise<FileDriverReply> {
  const edit = context.edit, operation = context.operation;
  if (operation.kind !== 'write-file' || !validEditFor('apply', edit)) return refused('invalid-commit');
  if (!operation.expectedSha256 || !/^[a-f0-9]{64}$/u.test(operation.expectedSha256)) return refused('invalid-commit');
  const content = Buffer.from(operation.content, 'utf8');
  if (content.length > FILE_MAX_BYTES) return refused('file-too-large');
  const directory = path.posix.dirname(operation.path), fileName = path.posix.basename(operation.path);
  const staging = path.posix.join(directory, `.cloudhelm-edit-${edit.transactionId}`);
  const entry = path.posix.join(staging, 'entry');
  const backup = recoveryBackupPath(directory, fileName, edit.transactionId);
  let stagingCreated = false, backupLinked = false, published = false;
  const refuseAfterCleanup = async (reply: FileDriverReply): Promise<FileDriverReply> => {
    if (!stagingCreated && !backupLinked) return reply;
    try {
      await cleanupArtifacts(context, { ...(stagingCreated ? { staging, entry } : {}), ...(backupLinked ? { backup } : {}) });
      return reply;
    } catch { return unknownPossible('cleanup-failed'); }
  };
  try {
    // Phase 1+2 (one SFTP session): validate the live target, then stage the
    // new content and copy the approved uid/gid/mode onto the staged entry.
    const live = await context.sftp(async (sftp) => {
      await walkParents(sftp, directory);
      const target = await readLive(sftp, operation.path, FILE_MAX_BYTES);
      if (sha256hex(target.bytes) !== operation.expectedSha256 || statDigest(target.stat) !== edit.expectedMetadataDigest)
        throw new FileRefused('source-version-or-metadata-changed');
      if (target.stat.uid !== context.executionUid) throw new FileRefused('ownership-preservation-unavailable');
      await mkdirExclusive(sftp, staging, 0o700).catch(() => { throw new FileRefused('staging-directory-failed'); });
      stagingCreated = true;
      const dirStat = await lstatOptional(sftp, staging);
      if (!dirStat?.isDirectory() || (dirStat.mode & 0o7777) !== 0o700 || dirStat.uid !== context.executionUid) throw new FileRefused('unsafe-staging-directory');
      await writeFileExclusive(sftp, entry, content, 0o600);
      await setstat(sftp, entry, { uid: target.stat.uid, gid: target.stat.gid, mode: target.stat.mode & 0o7777 });
      const staged = await readLive(sftp, entry, FILE_MAX_BYTES);
      if (!staged.bytes.equals(content)) throw new FileRefused('staged-content-mismatch');
      if (attributeDigestOf(staged.stat) !== attributeDigestOf(target.stat)) throw new FileRefused('staged-metadata-mismatch');
      return target;
    });
    // Commit step 1: hard-link backup of the current target inode.
    const link = await context.runCommand(`ln -- ${quote(operation.path)} ${quote(backup)}`);
    if (link.state === 'unknown') return unknownPossible('commit-outcome-unknown');
    if (link.state === 'not-dispatched') return refuseAfterCleanup(refused('commit-not-dispatched'));
    if (link.exitCode !== 0) return refuseAfterCleanup(refused('backup-link-failed'));
    backupLinked = true;
    // Phase 3: the backup must hold the approved bytes and the target must not
    // have moved since phase 1; both verified before the publishing rename.
    await context.sftp(async (sftp) => {
      const saved = await readLive(sftp, backup, FILE_MAX_BYTES);
      if (!saved.bytes.equals(live.bytes) || saved.stat.size !== live.stat.size) throw new FileRefused('source-version-or-metadata-changed');
      const currentTarget = await lstatOptional(sftp, operation.path);
      if (!currentTarget?.isFile() || statDigest(currentTarget) !== statDigest(live.stat)) throw new FileRefused('source-changed-before-publish');
    });
    // Commit step 2: same-directory POSIX rename publishes the staged entry.
    const move = await context.runCommand(`mv -- ${quote(entry)} ${quote(operation.path)}`);
    if (move.state === 'unknown') return unknownPossible('commit-outcome-unknown');
    if (move.state === 'not-dispatched') return refuseAfterCleanup(refused('commit-not-dispatched'));
    if (move.exitCode !== 0) return refuseAfterCleanup(refused('publish-failed'));
    published = true;
    // Phase 4: read back the published target. A mismatch stays unknown: the
    // backup file remains the recovery material and nothing is rolled back.
    const after = await verifyPublished(context, sha256hex(content), edit.expectedAttributeDigest);
    await context.sftp(async (sftp) => rmdirOptional(sftp, staging)).catch(() => undefined);
    const snapshot = buildInspection({ path: operation.path, bytes: after.bytes, executionUid: context.executionUid,
      uid: after.stat.uid, gid: after.stat.gid, mode: after.stat.mode & 0o7777, mtimeSec: after.stat.mtime });
    return { status: 'committed', snapshot,
      recovery: { version: 1, directoryId: edit.transactionId, path: operation.path,
        beforeSha256: sha256hex(live.bytes), beforeMetadataDigest: statDigest(live.stat),
        afterSha256: snapshot.sha256, afterMetadataDigest: snapshot.metadataDigest } };
  } catch (error) {
    if (error instanceof FileRefused) return published ? unknownPossible(error.code) : refuseAfterCleanup(refused(error.code));
    return published || backupLinked ? unknownPossible('file-transaction-interrupted') : refuseAfterCleanup(refused('file-transaction-interrupted'));
  }
}

async function restoreTransaction(context: SftpTransactionContext): Promise<FileDriverReply> {
  const edit = context.edit, operation = context.operation;
  if (operation.kind !== 'write-file' || !validEditFor('restore', edit)
    || !edit.backupTransactionId || !edit.expectedBackupMetadataDigest) return refused('invalid-commit');
  if (!operation.expectedSha256 || !/^[a-f0-9]{64}$/u.test(operation.expectedSha256)) return refused('invalid-commit');
  const content = Buffer.from(operation.content, 'utf8');
  if (content.length > FILE_MAX_BYTES) return refused('file-too-large');
  const directory = path.posix.dirname(operation.path), fileName = path.posix.basename(operation.path);
  const source = recoveryBackupPath(directory, fileName, edit.backupTransactionId);
  const displaced = recoveryBackupPath(directory, fileName, edit.transactionId);
  let backupLinked = false, published = false;
  const refuseAfterCleanup = async (reply: FileDriverReply): Promise<FileDriverReply> => {
    if (!backupLinked) return reply;
    try {
      await cleanupArtifacts(context, { backup: displaced });
      return reply;
    } catch { return unknownPossible('cleanup-failed'); }
  };
  try {
    // Phase 1: the live target must match the approved state and the recovery
    // backup must still hold the exact reviewed original bytes and metadata.
    const live = await context.sftp(async (sftp) => {
      await walkParents(sftp, directory);
      const target = await readLive(sftp, operation.path, FILE_MAX_BYTES);
      if (sha256hex(target.bytes) !== operation.expectedSha256 || statDigest(target.stat) !== edit.expectedMetadataDigest)
        throw new FileRefused('source-version-or-metadata-changed');
      if (target.stat.uid !== context.executionUid) throw new FileRefused('ownership-preservation-unavailable');
      const original = await readLive(sftp, source, FILE_MAX_BYTES);
      if (!original.bytes.equals(content)) throw new FileRefused('recovery-content-mismatch');
      if (statDigest(original.stat) !== edit.expectedBackupMetadataDigest) throw new FileRefused('recovery-version-or-metadata-changed');
      return target;
    });
    // Commit step 1: back up the displaced current content first.
    const link = await context.runCommand(`ln -- ${quote(operation.path)} ${quote(displaced)}`);
    if (link.state === 'unknown') return unknownPossible('commit-outcome-unknown');
    if (link.state === 'not-dispatched') return refuseAfterCleanup(refused('commit-not-dispatched'));
    if (link.exitCode !== 0) return refuseAfterCleanup(refused('backup-link-failed'));
    backupLinked = true;
    // Phase 2: the displaced backup must equal the observed live bytes.
    await context.sftp(async (sftp) => {
      const saved = await readLive(sftp, displaced, FILE_MAX_BYTES);
      if (!saved.bytes.equals(live.bytes) || saved.stat.size !== live.stat.size) throw new FileRefused('source-changed-before-restore');
    });
    // Commit step 2: rename the original inode back into place; uid/gid/mode
    // and mtime are the original's because the inode moves, not a copy.
    const move = await context.runCommand(`mv -- ${quote(source)} ${quote(operation.path)}`);
    if (move.state === 'unknown') return unknownPossible('commit-outcome-unknown');
    if (move.state === 'not-dispatched') return refuseAfterCleanup(refused('commit-not-dispatched'));
    if (move.exitCode !== 0) return refuseAfterCleanup(refused('publish-failed'));
    published = true;
    // Phase 3: read back the restored inode against the approved digests.
    const after = await verifyPublished(context, sha256hex(content), edit.expectedAttributeDigest);
    const snapshot = buildInspection({ path: operation.path, bytes: after.bytes, executionUid: context.executionUid,
      uid: after.stat.uid, gid: after.stat.gid, mode: after.stat.mode & 0o7777, mtimeSec: after.stat.mtime });
    return { status: 'committed', snapshot,
      recovery: { version: 1, directoryId: edit.transactionId, path: operation.path,
        beforeSha256: sha256hex(live.bytes), beforeMetadataDigest: statDigest(live.stat),
        afterSha256: snapshot.sha256, afterMetadataDigest: snapshot.metadataDigest } };
  } catch (error) {
    if (error instanceof FileRefused) return published ? unknownPossible(error.code) : refuseAfterCleanup(refused(error.code));
    return published || backupLinked ? unknownPossible('file-transaction-interrupted') : refuseAfterCleanup(refused('file-transaction-interrupted'));
  }
}

async function listRecovery(context: SftpTransactionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (operation.kind !== 'list-recovery' || !validRemoteFilePath(operation.path)) return refused('invalid-path');
  return context.sftp(async (sftp) => {
    const container = await lstatOptional(sftp, operation.path);
    if (!container?.isDirectory() || container.isSymbolicLink()) throw new FileRefused('not-a-recovery-container');
    const names = (await readdir(sftp, operation.path)).map((item) => item.filename).filter(validRecoveryEntryName).sort();
    const entries: RecoveryEntry[] = [];
    let truncated = false;
    for (const name of names) {
      if (entries.length >= 128) { truncated = true; break; }
      const stat = await lstatOptional(sftp, path.posix.join(operation.path, name));
      if (!stat || stat.uid !== context.executionUid) continue;
      if (RECOVERY_DIRECTORY_NAME.test(name)) {
        if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700) continue;
        const inner = await lstatOptional(sftp, path.posix.join(operation.path, name, 'entry'));
        entries.push({ name, kind: 'edit-directory', size: inner?.isFile() ? inner.size : 0, mtimeMs: stat.mtime * 1000 });
      } else {
        if (!stat.isFile()) continue;
        entries.push({ name, kind: 'backup-file', size: stat.size, mtimeMs: stat.mtime * 1000 });
      }
    }
    return { status: 'listed', entries, ...(truncated ? { truncated: true } : {}) };
  });
}

async function cleanupRecovery(context: SftpTransactionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (operation.kind !== 'cleanup-recovery' || !validRemoteFilePath(operation.path)) return refused('invalid-path');
  if (operation.names.some((name) => !validRecoveryEntryName(name))) return refused('unsafe-recovery-entry');
  return context.sftp(async (sftp) => {
    const items: RecoveryCleanupResult[] = [];
    for (const name of operation.names) {
      try {
        const target = path.posix.join(operation.path, name);
        const stat = await lstatOptional(sftp, target);
        if (!stat) { items.push({ name, result: 'missing' }); continue; }
        if (stat.uid !== context.executionUid) { items.push({ name, result: 'refused', code: 'unsafe-recovery-entry' }); continue; }
        if (RECOVERY_DIRECTORY_NAME.test(name)) {
          if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700) { items.push({ name, result: 'refused', code: 'unsafe-recovery-directory' }); continue; }
          const inner = await readdir(sftp, target);
          if (inner.length > 64 || inner.some((item) => item.filename !== 'entry')) { items.push({ name, result: 'refused', code: 'unsafe-recovery-directory' }); continue; }
          for (const item of inner) await unlinkOptional(sftp, path.posix.join(target, item.filename));
          await rmdirOptional(sftp, target);
          items.push({ name, result: 'removed' });
        } else {
          if (!stat.isFile()) { items.push({ name, result: 'refused', code: 'unsafe-recovery-file' }); continue; }
          await unlinkOptional(sftp, target);
          items.push({ name, result: 'removed' });
        }
      } catch (error) {
        // A definitive SFTP status code settles this row; a channel death
        // leaves the whole cleanup unknown for the runner to classify.
        const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
        if (typeof code !== 'number') throw error;
        items.push({ name, result: 'refused', code: RECOVERY_DIRECTORY_NAME.test(name) ? 'rmdir-failed' : 'unlink-failed' });
      }
    }
    return { status: 'cleaned', items };
  });
}
