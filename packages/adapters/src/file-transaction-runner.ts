import { createHash, randomUUID } from 'node:crypto';
import { FILE_TRANSACTION_HASH, FILE_TRANSACTION_UUID, type FileInspection, type FileRecovery, type ProposedOperation } from '@cloudhelm/core';
import { SshCommandTerminal } from './ssh-command-terminal.js';
import type { SshTransport } from './ssh-transport.js';
import { remoteFileProgram } from './remote-file-program.js';

type FileOperation = Extract<ProposedOperation, { kind: 'write-file' | 'inspect-file' }>;
export type FileSecretInput = (operation: FileOperation, signal: AbortSignal, attempt: number) => Promise<string | null>;
export interface FileDriverReply { status: 'inspected' | 'committed' | 'refused' | 'unknown';
  snapshot?: FileInspection; recovery?: FileRecovery; code?: string; effects?: 'none' | 'possible'; authenticationFailed?: boolean }
const quote = (text: string) => `'${text.replace(/'/gu, `'"'"'`)}'`;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function inspection(raw: any, path: string, root: boolean): FileInspection {
  if (!raw || raw.version !== 1 || raw.path !== path || !FILE_TRANSACTION_HASH.test(raw.sha256)
    || !FILE_TRANSACTION_HASH.test(raw.metadataDigest) || !FILE_TRANSACTION_HASH.test(raw.attributeDigest)
    || typeof raw.contentBase64 !== 'string' || raw.contentBase64.length > 1_398_104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw.contentBase64)
    || !['uid', 'gid', 'mode', 'executionUid', 'size'].every((key) => Number.isSafeInteger(raw[key]) && raw[key] >= 0)
    || raw.size > 1_048_576 || raw.mode > 0o7777 || root && raw.executionUid !== 0
    || !['device', 'inode'].every((key) => typeof raw[key] === 'string' && /^\d{1,24}$/u.test(raw[key]))
    || typeof raw.commitSupported !== 'boolean' || typeof raw.limitation !== 'string' || raw.limitation.length > 128
    || raw.commitSupported && (raw.executionUid !== 0 || raw.limitation !== '' || (raw.mode & 0o7000) !== 0))
    throw new Error('Invalid private inspection receipt');
  const bytes = Buffer.from(raw.contentBase64, 'base64'), content = bytes.toString('utf8');
  if (bytes.length !== raw.size || hash(bytes) !== raw.sha256 || !Buffer.from(content).equals(bytes) || content.includes('\0'))
    throw new Error('File is not complete UTF-8 text');
  return { version: 1, path, content, sha256: raw.sha256, metadataDigest: raw.metadataDigest, attributeDigest: raw.attributeDigest,
    uid: raw.uid, gid: raw.gid, mode: raw.mode, executionUid: raw.executionUid, size: raw.size,
    device: raw.device, inode: raw.inode, commitSupported: raw.commitSupported, limitation: raw.limitation };
}
export function validFileRecovery(value: any, path?: string): value is FileRecovery {
  const fields = ['version', 'directoryId', 'path', 'beforeSha256', 'beforeMetadataDigest', 'afterSha256', 'afterMetadataDigest'];
  return !!value && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key))
    && value.version === 1 && FILE_TRANSACTION_UUID.test(value.directoryId) && typeof value.path === 'string'
    && value.path.startsWith('/') && value.path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value.path)
    && (!path || value.path === path) && fields.slice(3).every((key) => typeof value[key] === 'string' && FILE_TRANSACTION_HASH.test(value[key]));
}

/** Private supervised process: stdout and launch argv never enter terminal/audit
 * logs. Only the SDK's trusted sudo challenge reaches the operation-bound UI. */
export class FileTransactionRunner {
  constructor(private readonly ssh: SshTransport, private readonly secret?: FileSecretInput,
    private readonly factory = (host: string) => new SshCommandTerminal(ssh, host)) {}
  async run(operation: FileOperation, current: () => boolean, signal?: AbortSignal): Promise<FileDriverReply> {
    const edit = operation.kind === 'write-file' ? operation.fileEdit : undefined;
    const action = operation.kind === 'inspect-file' ? operation.recoveryDirectoryId ? 'inspect-backup' : 'inspect' : edit?.action;
    if (!action || !current()) return { status: 'refused', effects: 'none', code: 'authorization-expired' };
    const root = operation.privilege === 'root', nonce = randomUUID().replaceAll('-', '');
    const transactionId = edit?.transactionId ?? randomUUID();
    const request = { version: 1, nonce, action, path: operation.path, root, transactionId,
      ...(operation.kind === 'inspect-file' ? { backupTransactionId: operation.recoveryDirectoryId } : {
        expectedSha256: operation.expectedSha256, expectedMetadataDigest: edit!.expectedMetadataDigest,
        expectedExecutionUid: edit!.expectedExecutionUid, backupTransactionId: edit!.backupTransactionId,
        expectedBackupMetadataDigest: edit!.expectedBackupMetadataDigest, contentBase64: Buffer.from(operation.content).toString('base64') }) };
    const payload = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(payload) > 2 * 1_048_576) return { status: 'refused', effects: 'none', code: 'request-too-large' };
    const raw = this.factory(operation.scope.hostId), controller = new AbortController();
    const sudo = root && operation.scope.loginAs !== 'root';
    const command = `${sudo ? 'sudo -- ' : ''}/usr/bin/python3 -I -S -B -c ${quote(remoteFileProgram)} ${quote(nonce)}`;
    let sent = false, active = true, buffer = '', reply: FileDriverReply | undefined, attempts = 0;
    let challenge: { id: string; controller: AbortController } | undefined;
    let failure: { effects?: 'none' | 'possible'; failureKind?: string } | undefined;
    let finish!: (value: FileDriverReply) => void;
    const done = new Promise<FileDriverReply>((resolve) => { finish = (value) => { if (!active) return; active = false; resolve(value); }; });
    const unknown = (): FileDriverReply => ({ status: sent && action !== 'inspect' && action !== 'inspect-backup' ? 'unknown' : 'refused',
      effects: sent && action !== 'inspect' && action !== 'inspect-backup' ? 'possible' : 'none', code: 'private-channel-interrupted', ...(!sent && (sudo && attempts > 0 || failure?.failureKind === 'authentication-failed') ? { authenticationFailed: true } : {}) });
    const stop = () => { controller.abort(); finish(unknown()); raw.close(); };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 180_000);
    const lease = setInterval(() => { if (!current()) stop(); }, 100);
    raw.onDisplay(() => {});
    raw.onExecutionFailure((value) => { failure = value; });
    raw.onAuthentication((value) => {
      if (!active) return;
      if (!value.prompt) { if (challenge?.id === value.id) { challenge.controller.abort(); challenge = undefined; } return; }
      if (!sudo || !this.secret || challenge || ++attempts > 3 || !current()) {
        raw.answerAuthentication(value.id, null);
        finish(sent ? unknown() : { status: 'refused', effects: 'none', code: 'authentication-stopped', authenticationFailed: true }); stop(); return;
      }
      const entry = { id: value.id, controller: new AbortController() }; challenge = entry;
      const authSignal = AbortSignal.any([controller.signal, entry.controller.signal]);
      void Promise.resolve().then(() => this.secret!(operation, authSignal, attempts)).then((answer) => {
        if (challenge !== entry || !active || !current() || authSignal.aborted) return;
        challenge = undefined;
        if (answer === null || !raw.answerAuthentication(entry.id, answer)) {
          finish(sent ? unknown() : { status: 'refused', effects: 'none', code: 'authentication-canceled', authenticationFailed: true }); stop();
        }
      }).catch(() => { if (challenge === entry && active) { finish(sent ? unknown() : { status: 'refused', effects: 'none', code: 'authentication-unavailable', authenticationFailed: true }); stop(); } });
    });
    raw.onData((text) => {
      if (!active) return;
      buffer += text;
      if (Buffer.byteLength(buffer) > 2 * 1_048_576) { stop(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.ready === nonce && !sent && Object.keys(value).length === 1) {
            if (!current()) { stop(); return; }
            sent = true;
            for (let i = 0; i < payload.length; i += 1024) raw.write(payload.slice(i, i + 1024));
          } else if (value.nonce === nonce && sent && ['inspected', 'committed', 'refused', 'unknown'].includes(value.status)) {
            if (reply) throw new Error('Duplicate receipt');
            if (value.status === 'inspected' || value.status === 'committed') {
              const snapshot = inspection(value.snapshot, operation.path, root);
              if (value.status === 'committed' && (operation.kind !== 'write-file' || snapshot.sha256 !== hash(Buffer.from(operation.content))
                || snapshot.attributeDigest !== edit!.expectedAttributeDigest || snapshot.executionUid !== edit!.expectedExecutionUid || !validFileRecovery(value.recovery, operation.path)
                || value.recovery.beforeSha256 !== operation.expectedSha256 || value.recovery.afterSha256 !== snapshot.sha256
                || value.recovery.afterMetadataDigest !== snapshot.metadataDigest
                || value.recovery.directoryId !== (edit!.backupTransactionId ?? edit!.transactionId))) throw new Error('Commit receipt does not match approved content');
              reply = { status: value.status, snapshot, ...(value.recovery ? { recovery: value.recovery } : {}) };
            } else reply = { status: value.status, effects: value.status === 'refused' && value.effects === 'none' ? 'none' : 'possible',
              code: typeof value.code === 'string' && /^[a-z0-9-]{1,120}$/u.test(value.code) ? value.code : 'file-operation-refused' };
          } else throw new Error('Invalid private file protocol');
        } catch { stop(); }
      }
    });
    raw.onExit((code) => finish(code === 0 && reply ? reply : !sent && failure?.effects === 'none'
      ? { status: 'refused', effects: 'none', code: 'file-helper-not-started', authenticationFailed: failure.failureKind === 'authentication-failed' } : unknown()));
    raw.onClose(() => finish(unknown()));
    try {
      if (signal?.aborted || !current()) stop();
      else void raw.execute(command, operation.scope.cwd, current, { sudoAuthorization: sudo }).catch(() => finish(sent ? unknown()
        : { status: 'refused', effects: 'none', code: 'file-helper-unavailable' }));
      return await done;
    } finally {
      active = false; clearTimeout(timer); clearInterval(lease); signal?.removeEventListener('abort', stop);
      controller.abort(); challenge?.controller.abort(); raw.close();
    }
  }
}
