import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileTransactionRunner, RemoteFileError, RemoteFileMissingError, type FileSecretInput, type SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type ExecutionOptions, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { TerminalManager } from '@cloudhelm/application';
import { LocalFileAccess } from './local-file-access.js';
import { executeControlledFile } from './controlled-file-executor.js';

/** Executes reviewed structured writes over SFTP without exposing arbitrary SFTP access to the renderer. */
export class FileOperationExecutor implements OperationExecutor {
  readonly supportsFileTransactions = true;
  private fileDriver?: FileTransactionRunner;
  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly commands: OperationExecutor, private readonly secret?: FileSecretInput) {}
  /** Built only for a controlled file operation, so ordinary, legacy and privileged
   * command paths never depend on the file driver being present. */
  private driver(): FileTransactionRunner { return this.fileDriver ??= new FileTransactionRunner(this.ssh, this.secret); }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (operation.kind === 'command') return this.commands.execute(operation, fingerprint, signal, options);
    const connectionGeneration = this.ssh.connectionGeneration(operation.scope.hostId);
    const authorized = () => operationFingerprint(operation) === fingerprint && !signal?.aborted && options?.isAuthorized?.() !== false
      && this.ssh.connectionGeneration(operation.scope.hostId) === connectionGeneration
      && this.terminal.isAgentOwner(operation.scope.terminalId)
      && this.terminal.currentGeneration(operation.scope.terminalId) === operation.scope.terminalGeneration
      && this.terminal.hostOf(operation.scope.terminalId) === operation.scope.hostId
      && this.terminal.taskOf(operation.scope.terminalId) === operation.scope.taskId;
    const assertAuthorized = () => { if (!authorized()) throw new Error('Structured file operation authorization expired'); };
    // Nothing below this line has touched the host yet, so a refusal here is a
    // dispatch-boundary failure: no remote effects and no outcome to verify.
    const notDispatched = (message: string): OperationResult => ({ operationId: operation.id,
      status: 'failed', effects: 'none', failureKind: 'not-dispatched', stdoutTail: message });
    if (!authorized()) return notDispatched('Authorization expired before any remote call; nothing was written. Propose the operation again.');
    if (operation.kind === 'inspect-file' || operation.kind === 'write-file' && operation.fileEdit)
      return executeControlledFile(this.driver(), operation, authorized, signal, options);
    const remotePath = path.posix.resolve(operation.scope.cwd,
      operation.kind === 'upload' ? operation.remotePath : operation.path);
    let remoteStarted = false;
    try {
      let content: Buffer | undefined;
      if (operation.kind === 'upload') {
        try { content = (await new LocalFileAccess([{ path: operation.localRoot, kind: 'directory' }]).read(operation.localPath)).data; }
        catch (error) {
          return notDispatched(`Selected local file could not be read after review (${error instanceof Error ? error.message : String(error)}); nothing was sent to the host. Propose the upload again.`);
        }
        if (content.length !== operation.size || createHash('sha256').update(content).digest('hex') !== operation.contentSha256) {
          return notDispatched('Selected local file changed after review; nothing was sent to the host. Propose the upload again with the current file.');
        }
      }
      // Version preflight before any remote mutation, not an atomic CAS. An existing file may only be
      // replaced with the exact content the review was based on; a truncated read
      // has no hash, so it can never authorize a whole-file overwrite.
      const intended = operation.kind === 'write-file' ? Buffer.from(operation.content) : content!;
      if (operation.kind !== 'delete-path' && intended.length > 1_048_576)
        return notDispatched('Structured writes are limited to 1 MiB; nothing was written.');
      // Always confirm the current state first: an existing file may only be replaced
      // with the exact reviewed content and a supporting metadata-preserving backend.
      // Current SFTP refuses existing targets even with a hash; createOnly is enforced.
      if (operation.kind === 'write-file') {
        if (operation.createOnly && operation.expectedSha256) return notDispatched('Choose createOnly or expectedSha256, not both.');
        let current: Awaited<ReturnType<SshTransport['readFileForEdit']>> | undefined;
        try {
          current = await this.ssh.readFileForEdit(operation.scope.hostId, remotePath, 1_048_576, signal);
        } catch (error) {
          if (!(error instanceof RemoteFileMissingError)) {
            return notDispatched(`Could not confirm the current remote file (${error instanceof Error ? error.message : String(error)}); nothing was written.`);
          }
        }
        if (!current && operation.expectedSha256) return notDispatched('Remote file disappeared since it was read; nothing was written.');
        if (operation.createOnly && current) return notDispatched('Remote file already exists; create-only was requested, so nothing was written.');
        if (current && !operation.expectedSha256) return notDispatched('Remote file already exists and no expected hash was supplied; read it first, then propose the exact replacement.');
        if (current && current.sha256 !== operation.expectedSha256) {
          return notDispatched('Remote file changed since it was read; nothing was written. Read it again and propose a new replacement.');
        }
      }
      if (!authorized()) return notDispatched('Authorization expired before the remote call; nothing was written. Propose the operation again.');
      remoteStarted = true;
      const written = operation.kind === 'delete-path'
        ? { backup: await this.ssh.deleteFile(operation.scope.hostId, remotePath, assertAuthorized, signal) }
        : await this.ssh.writeFile(operation.scope.hostId, remotePath, intended, assertAuthorized, signal,
          operation.kind === 'write-file'
            ? { expectedSha256: operation.expectedSha256, createOnly: !operation.expectedSha256 }
            : {});
      const backup = written?.backup;
      const handover = !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration;
      // Read the result back: a recovery copy is not proof that the new content landed,
      // and it is not a general rollback of the service's expectations.
      let verification = '';
      let verified = operation.kind === 'delete-path';
      if (operation.kind !== 'delete-path') {
        const expected = createHash('sha256').update(intended).digest('hex');
        try {
          const written = await this.ssh.readFileForEdit(operation.scope.hostId, remotePath, 1_048_576, signal);
          verified = !written.truncated && written.sha256 === expected;
          verification = verified
            ? ` Verified read-back hash ${expected.slice(0, 12)}….`
            : ` WARNING: read-back hash ${written.sha256?.slice(0, 12) ?? 'unavailable'}… does not match the written content ${expected.slice(0, 12)}…; inspect the file before relying on it.`;
        } catch (error) {
          verification = ` Read-back verification failed (${error instanceof Error ? error.message : String(error)}); the write was requested but its final content is unconfirmed.`;
        }
      }
      return {
        operationId: operation.id, status: handover ? 'handed-over' : verified ? 'succeeded' : 'unknown',
        ...(verified && !handover ? { exitCode: 0 } : {}),
        ...(!verified ? { effects: 'possible' as const, failureKind: 'unknown' as const } : {}),
        stdoutTail: `${operation.kind === 'delete-path' ? 'Deleted' : 'Wrote'} ${remotePath}.`
          + (backup ? ` Content-only recovery copy: ${backup} (file bytes only; owner/group/mode, ACL/xattr and service state are not restored).` : ' New file; no previous version.')
          + (written && 'modeDropped' in written && written.modeDropped
            ? ` Special mode bits ${written.modeDropped} were not preserved; re-apply them only if the service still needs them.` : '')
          + verification,
        logRef: operation.scope.terminalId
      };
    } catch (error) {
      const effects = error instanceof RemoteFileError ? error.effects : remoteStarted ? 'possible' : 'none';
      const permissionDenied = error instanceof RemoteFileError && error.permissionDenied;
      return { operationId: operation.id, status: effects === 'possible' ? 'unknown' : 'failed', effects,
        // A transport that reports no effects proves nothing was changed remotely;
        // the result is a correctable failure, not an outcome that must be verified.
        failureKind: permissionDenied ? 'permission-denied' : effects === 'none' ? 'not-dispatched' : 'unknown',
        stdoutTail: effects === 'none'
          ? `No remote change: ${error instanceof Error ? error.message : String(error)}`
          : `SFTP operation needs verification: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
