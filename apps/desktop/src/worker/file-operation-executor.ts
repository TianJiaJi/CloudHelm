import path from 'node:path';
import { createHash } from 'node:crypto';
import { RemoteFileError, type SshTransport } from '@cloudhelm/adapters';
import { operationFingerprint, type ExecutionOptions, type OperationExecutor, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { TerminalManager } from '@cloudhelm/application';
import { LocalFileAccess } from './local-file-access.js';

/** Executes reviewed structured writes over SFTP without exposing arbitrary SFTP access to the renderer. */
export class FileOperationExecutor implements OperationExecutor {
  constructor(private readonly terminal: TerminalManager, private readonly ssh: SshTransport,
    private readonly commands: OperationExecutor) {}

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
      if (!authorized()) return notDispatched('Authorization expired before the remote call; nothing was written. Propose the operation again.');
      remoteStarted = true;
      const backup = operation.kind === 'delete-path'
        ? await this.ssh.deleteFile(operation.scope.hostId, remotePath, assertAuthorized, signal)
        : await this.ssh.writeFile(operation.scope.hostId, remotePath,
          operation.kind === 'write-file' ? Buffer.from(operation.content) : content!, assertAuthorized, signal);
      const handover = !this.terminal.isAgentOwner(operation.scope.terminalId)
        || this.terminal.currentGeneration(operation.scope.terminalId) !== operation.scope.terminalGeneration;
      return {
        operationId: operation.id, status: handover ? 'handed-over' : 'succeeded', exitCode: 0,
        stdoutTail: `${operation.kind === 'delete-path' ? 'Deleted' : 'Wrote'} ${remotePath}.`
          + (backup ? ` Recovery copy: ${backup}` : ' New file; no previous version.'),
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
