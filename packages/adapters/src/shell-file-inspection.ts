import path from 'node:path';
import { createHash } from 'node:crypto';
import { RECOVERY_DIRECTORY_NAME, validRecoveryEntryName, type FileEditCommit, type RecoveryCleanupResult, type RecoveryEntry } from '@cloudhelm/core';
import type { FileCommandOutcome } from './file-native-command.js';
import { buildInspection, FILE_MAX_BYTES, FileRefused, quote, refused, recoveryBackupPath,
  validRemoteFilePath, type FileAction, type FileDriverReply, type FileOperation } from './file-transaction-protocol.js';

/** Route B context: only literal read/cleanup shell commands; no SFTP exists. */
export interface ShellInspectionContext {
  operation: FileOperation; action: FileAction; edit?: FileEditCommit; transactionId: string; executionUid: number;
  runCommand: (command: string, timeoutMs?: number) => Promise<FileCommandOutcome>;
}

/** SFTP is required for every controlled write: staging, attribute-preserving
 * publication and receipt verification have no safe shell-only replacement. */
const SFTP_REQUIRED = 'sftp-required-for-controlled-writes';

/** Route B: shell-only degraded set for hosts without SFTP. Inspections run
 * through reviewed literal stat/sha256sum/head commands; commits are refused
 * before any remote effect. TOCTOU protection is the documented weaker set:
 * no O_NOFOLLOW, consistency is re-checked between stat, hash and read. */
export async function shellFileInspection(context: ShellInspectionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (context.action === 'apply' || context.action === 'restore') return refused(SFTP_REQUIRED);
  try {
    switch (context.action) {
      case 'inspect': return await inspectTarget(context, operation.path);
      case 'inspect-backup': return await inspectBackup(context);
      case 'list-recovery': return await listRecovery(context);
      case 'cleanup-recovery': return await cleanupRecovery(context);
    }
  } catch (error) {
    if (error instanceof FileRefused) return refused(error.code);
    throw error;
  }
  return refused('invalid-action');
}

async function requireExited(context: ShellInspectionContext, command: string): Promise<{ exitCode: number; output: string }> {
  const outcome = await context.runCommand(command);
  if (outcome.state === 'not-dispatched') throw new FileRefused('file-command-unavailable');
  if (outcome.state === 'unknown') throw new FileRefused('file-command-unknown');
  return { exitCode: outcome.exitCode, output: outcome.output };
}

/** stat -c line: size|raw-hex-mode|uid|gid|mtimeSec, lstat semantics (GNU/BusyBox). */
const STAT_PATTERN = /^(\d{1,19})\|([0-9a-f]{1,6})\|(\d{1,10})\|(\d{1,10})\|(\d{1,19})$/u;
async function statFile(context: ShellInspectionContext, target: string): Promise<{ size: number; mode: number; uid: number; gid: number; mtimeSec: number }> {
  const outcome = await requireExited(context, `stat -c '%s|%f|%u|%g|%Y' -- ${quote(target)}`);
  if (outcome.exitCode !== 0) throw new FileRefused('file-missing');
  const match = STAT_PATTERN.exec(outcome.output.trim());
  if (!match) throw new FileRefused('file-command-output-invalid');
  const raw = Number.parseInt(match[2]!, 16);
  if ((raw & 0o170000) !== 0o100000) throw new FileRefused('not-a-bounded-single-link-file');
  return { size: Number(match[1]!), mode: raw & 0o7777, uid: Number(match[3]!), gid: Number(match[4]!), mtimeSec: Number(match[5]!) };
}

async function readBounded(context: ShellInspectionContext, target: string, size: number): Promise<{ sha256: string; bytes: Buffer }> {
  const hashOutcome = await requireExited(context, `sha256sum -- ${quote(target)}`);
  if (hashOutcome.exitCode !== 0) throw new FileRefused('file-missing');
  const sha256 = /^([a-f0-9]{64})[ \t]/u.exec(hashOutcome.output);
  if (!sha256) throw new FileRefused('file-command-output-invalid');
  const read = await requireExited(context, `head -c ${size} -- ${quote(target)}`);
  if (read.exitCode !== 0) throw new FileRefused('file-missing');
  if (read.output.includes('\ufffd')) throw new FileRefused('not-complete-utf8-text');
  const bytes = Buffer.from(read.output, 'utf8');
  if (bytes.length !== size || hashOf(bytes) !== sha256[1]) throw new FileRefused('source-changed-during-read');
  return { sha256: sha256[1]!, bytes };
}

const hashOf = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function inspectTarget(context: ShellInspectionContext, target: string): Promise<FileDriverReply> {
  if (!validRemoteFilePath(target)) return refused('invalid-path');
  const stat = await statFile(context, target);
  if (stat.size > FILE_MAX_BYTES) throw new FileRefused('file-too-large');
  const read = await readBounded(context, target, stat.size);
  // No SFTP means no staging or attribute-preserving publication: the snapshot
  // honestly reports an uncommittable file instead of issuing a commit token.
  const snapshot = buildInspection({ path: target, bytes: read.bytes, executionUid: context.executionUid,
    uid: stat.uid, gid: stat.gid, mode: stat.mode, mtimeSec: stat.mtimeSec });
  return { status: 'inspected', snapshot: { ...snapshot, commitSupported: false, limitation: SFTP_REQUIRED } };
}

async function inspectBackup(context: ShellInspectionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (operation.kind !== 'inspect-file' || !validRemoteFilePath(operation.path) || !operation.recoveryDirectoryId) return refused('invalid-path');
  const backup = recoveryBackupPath(path.posix.dirname(operation.path), path.posix.basename(operation.path), operation.recoveryDirectoryId);
  const stat = await statFile(context, backup);
  if (stat.size > FILE_MAX_BYTES) throw new FileRefused('file-too-large');
  const read = await readBounded(context, backup, stat.size);
  const snapshot = buildInspection({ path: operation.path, bytes: read.bytes, executionUid: context.executionUid,
    uid: stat.uid, gid: stat.gid, mode: stat.mode, mtimeSec: stat.mtimeSec });
  return { status: 'inspected', snapshot: { ...snapshot, commitSupported: false, limitation: SFTP_REQUIRED } };
}

async function listRecovery(context: ShellInspectionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (operation.kind !== 'list-recovery' || !validRemoteFilePath(operation.path)) return refused('invalid-path');
  const listed = await requireExited(context, `ls -1A -- ${quote(operation.path)}`);
  if (listed.exitCode !== 0) throw new FileRefused('not-a-recovery-container');
  const names = listed.output.split('\n').filter((line) => line !== '' && validRecoveryEntryName(line)).sort();
  const shown = names.slice(0, 128);
  // One stat per candidate keeps parsing unambiguous even for names containing '|'.
  const entries: RecoveryEntry[] = [];
  for (const name of shown) {
    const target = path.posix.join(operation.path, name);
    const stat = await statFile(context, target).catch(() => undefined);
    if (!stat || stat.uid !== context.executionUid) continue;
    if (RECOVERY_DIRECTORY_NAME.test(name)) {
      if (stat.mode !== 0o700) continue;
      const inner = await statFile(context, path.posix.join(target, 'entry')).catch(() => undefined);
      entries.push({ name, kind: 'edit-directory', size: inner?.size ?? 0, mtimeMs: stat.mtimeSec * 1000 });
    } else {
      entries.push({ name, kind: 'backup-file', size: stat.size, mtimeMs: stat.mtimeSec * 1000 });
    }
  }
  return { status: 'listed', entries, ...(names.length > 128 ? { truncated: true } : {}) };
}

async function cleanupRecovery(context: ShellInspectionContext): Promise<FileDriverReply> {
  const operation = context.operation;
  if (operation.kind !== 'cleanup-recovery' || !validRemoteFilePath(operation.path)) return refused('invalid-path');
  if (operation.names.some((name) => !validRecoveryEntryName(name))) return refused('unsafe-recovery-entry');
  const items: RecoveryCleanupResult[] = [];
  let removedAny = false;
  const interrupted = (): FileDriverReply => ({ status: 'unknown', effects: 'possible', code: 'cleanup-interrupted' });
  for (const name of operation.names) {
    const target = path.posix.join(operation.path, name);
    const directory = RECOVERY_DIRECTORY_NAME.test(name);
    const stat = await statFile(context, target);
    if (stat.uid !== context.executionUid) { items.push({ name, result: 'refused', code: 'unsafe-recovery-entry' }); continue; }
    if (directory) {
      if (stat.mode !== 0o700) { items.push({ name, result: 'refused', code: 'unsafe-recovery-directory' }); continue; }
      const removeEntry = await context.runCommand(`rm -f -- ${quote(path.posix.join(target, 'entry'))}`);
      if (removeEntry.state !== 'exited' || removeEntry.exitCode !== 0) return removedAny ? interrupted() : refused('file-command-unavailable');
      removedAny = true;
      const removeDir = await context.runCommand(`rmdir -- ${quote(target)}`);
      if (removeDir.state === 'not-dispatched') return removedAny ? interrupted() : refused('file-command-unavailable');
      if (removeDir.state === 'unknown') return interrupted();
      items.push(removeDir.exitCode === 0 ? { name, result: 'removed' } : { name, result: 'refused', code: 'rmdir-failed' });
    } else {
      const remove = await context.runCommand(`rm -f -- ${quote(target)}`);
      if (remove.state === 'not-dispatched') return removedAny ? interrupted() : refused('file-command-unavailable');
      if (remove.state === 'unknown') return interrupted();
      if (remove.exitCode !== 0) { items.push({ name, result: 'refused', code: 'unlink-failed' }); continue; }
      removedAny = true;
      items.push({ name, result: 'removed' });
    }
  }
  return { status: 'cleaned', items };
}
