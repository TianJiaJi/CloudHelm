import { randomUUID } from 'node:crypto';
import { FILE_TRANSACTION_HASH, FILE_TRANSACTION_UUID, type FileRecovery } from '@cloudhelm/core';
import { SshCommandTerminal } from './ssh-command-terminal.js';
import type { SshTransport } from './ssh-transport.js';
import { runFileCommand } from './file-native-command.js';
import { sftpFileTransaction } from './sftp-file-transaction.js';
import { shellFileInspection } from './shell-file-inspection.js';
import { fileActionOf, refused, validEditFor, FileRefused,
  type FileDriverReply, type FileOperation } from './file-transaction-protocol.js';

export type { FileDriverReply, FileOperation } from './file-transaction-protocol.js';

/** Structural guard for recovery receipts persisted with the operation record. */
export function validFileRecovery(value: any, path?: string): value is FileRecovery {
  const fields = ['version', 'directoryId', 'path', 'beforeSha256', 'beforeMetadataDigest', 'afterSha256', 'afterMetadataDigest'];
  return !!value && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key))
    && value.version === 1 && FILE_TRANSACTION_UUID.test(value.directoryId) && typeof value.path === 'string'
    && value.path.startsWith('/') && value.path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value.path)
    && (!path || value.path === path) && fields.slice(3).every((key) => typeof value[key] === 'string' && FILE_TRANSACTION_HASH.test(value[key]));
}

const UID_PATTERN = /^\d{1,10}\n?$/u;

/** Routes controlled file operations onto the SFTP transaction (route A) or the
 * shell-only degraded inspection set (route B). Probes are cached per
 * connection generation: a reconnect re-probes, a stable connection does not. */
export class FileTransactionRunner {
  private readonly sftpProbes = new Map<string, { generation: number; available: boolean }>();
  private readonly uidProbes = new Map<string, { generation: number; uid: number }>();

  constructor(private readonly ssh: SshTransport,
    private readonly factory = (hostId: string) => new SshCommandTerminal(this.ssh, hostId)) {}

  async run(operation: FileOperation, current: () => boolean): Promise<FileDriverReply> {
    const action = fileActionOf(operation);
    if (!action || !current()) return refused('authorization-expired');
    const write = action === 'apply' || action === 'restore';
    if (write && !validEditFor(action, operation.kind === 'write-file' ? operation.fileEdit : undefined))
      return refused('invalid-commit');
    const hostId = operation.scope.hostId;
    const generation = this.ssh.connectionGeneration(hostId);
    const sftpAvailable = await this.probeSftp(hostId, generation);
    if (write && !sftpAvailable) return refused('sftp-required-for-controlled-writes');
    // One private terminal per run: every literal file command shares it and it
    // is revoked once the transaction settles, whatever the outcome.
    const terminal = this.factory(hostId);
    try {
      const executionUid = await this.probeExecutionUid(terminal, operation, hostId, generation, current);
      if (executionUid === undefined) return refused('execution-identity-unavailable');
      if (operation.privilege === 'root' && executionUid !== 0) return refused('root-identity-unconfirmed');
      const runCommand = (command: string, timeoutMs?: number) =>
        runFileCommand(terminal, command, operation.scope.cwd, current, timeoutMs);
      const context = { operation, action,
        edit: operation.kind === 'write-file' ? operation.fileEdit : undefined,
        transactionId: operation.kind === 'write-file' ? operation.fileEdit?.transactionId ?? randomUUID() : randomUUID(),
        executionUid, runCommand };
      const reply = sftpAvailable
        ? sftpFileTransaction({ ...context, sftp: (work) => this.ssh.withSftpSession(hostId, work) })
        : shellFileInspection(context);
      return reply;
    } catch (error) {
      if (error instanceof FileRefused) return refused(error.code);
      // A channel death the route could not settle: a write may have partially
      // applied, a read-only route provably changed nothing.
      return { status: 'unknown', effects: write ? 'possible' : 'none', code: 'file-transaction-interrupted' };
    } finally {
      terminal.close();
    }
  }

  /** SFTP availability is structural per connection: subsystem support does not
   * appear mid-connection, so one probe per generation settles the route. */
  private async probeSftp(hostId: string, generation: number): Promise<boolean> {
    const cached = this.sftpProbes.get(hostId);
    if (cached?.generation === generation) return cached.available;
    let available = false;
    try {
      await this.ssh.withSftpSession(hostId, async (_sftp, assertActive) => { assertActive(); });
      available = true;
    } catch { available = false; }
    this.sftpProbes.set(hostId, { generation, available });
    return available;
  }

  /** The effective identity of the execution channel; every ownership decision
   * in both routes is bound to this one observed value. */
  private async probeExecutionUid(terminal: SshCommandTerminal, operation: FileOperation,
    hostId: string, generation: number, current: () => boolean): Promise<number | undefined> {
    const cached = this.uidProbes.get(hostId);
    if (cached?.generation === generation) return cached.uid;
    const outcome = await runFileCommand(terminal, 'id -u', operation.scope.cwd, current, 15_000);
    if (outcome.state !== 'exited' || outcome.exitCode !== 0) return undefined;
    const uid = Number(outcome.output.trim());
    if (!UID_PATTERN.test(outcome.output) || !Number.isSafeInteger(uid) || uid < 0) return undefined;
    this.uidProbes.set(hostId, { generation, uid });
    return uid;
  }
}
