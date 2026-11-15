import type { Static } from 'typebox';
import { FILE_EDIT_MAX_BYTES, prepareFileEdit, redactOutput, type BusinessTool } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { remoteFileEditParameters } from './remote-file-edit-schema.js';
import type { FileEditService } from './file-edit-service.js';
import { resolveRemoteReadTarget } from './remote-read-guard.js';

const policy = (host?: RuntimeHost) => host && JSON.stringify([host.id, host.username, host.policyRevision,
  host.archived, host.protectedReadPaths ?? host.protectedPaths]);

/** Read-only transaction preparation. No editId/approval token is minted until a
 * supported commit backend exists; hashes and preview text never grant authority. */
export function createRemoteFilePrepareTool(deps: RemoteToolDependencies, service?: FileEditService): BusinessTool<Static<typeof remoteFileEditParameters>> {
  return { name: 'prepare_remote_edit', label: 'Preview one version-bound remote text edit', replay: 'never',
    access: 'query', deferred: true, available: () => !!service || !!deps.readRemoteFile,
    parameters: remoteFileEditParameters,
    description: 'Prepare one exact edit, current identity or explicit privilege=root, using a complete safe sha256 and unique literal oldText/newText. Empty oldText is allowed only for an empty original. Full diff max 64 KiB, source/result max 1 MiB. Supported Linux metadata/atomic-exchange inspection yields a task/host/identity/version/metadata-bound expiring editId for apply_remote_edit; otherwise only a read-only preview, no commit token. No remote file is staged by preparation. Secrets, incomplete/stale data and changed authority are refused. Commit/restore needs new exact review and private authentication; never switch identity after a stop or replay unknown effects. Legacy SFTP is never an overwrite fallback.',
    execute: async (id, params, signal) => {
      if (service) return service.prepare(id, params, signal);
      const blocked = (code: string, message: string) => blockedOperationFeedback(id, code, message, undefined, true);
      if (params.privilege === 'root') return blocked('file-transactions-unavailable', 'Root inspection requires a controlled driver; no fallback or identity switch.');
      if (!deps.readRemoteFile) return blocked('remote-edit-unavailable', 'Audited remote reading unavailable; no preview or write.');
      const host = deps.hosts.find((item) => item.id === params.hostId), binding = policy(host);
      signal?.throwIfAborted();
      try {
        // The audited reader must also see denied host/path attempts. Never bypass
        // it with a raw SFTP read, even though this operation cannot mutate a file.
        const snapshot = await deps.readRemoteFile(params.hostId, params.path, '/', signal, FILE_EDIT_MAX_BYTES);
        const live = deps.hosts.find((item) => item.id === params.hostId);
        signal?.throwIfAborted();
        if (!host || live !== host || live.archived || policy(live) !== binding)
          return blocked('remote-edit-unavailable', 'Read authorization changed; discard this preview and read again. Nothing written.');
        const target = resolveRemoteReadTarget(params.path, '/');
        const prepared = prepareFileEdit(snapshot, params.expectedSha256, params.oldText, params.newText);
        if (prepared.kind === 'refused') return blocked(prepared.code, prepared.message);
        signal?.throwIfAborted();
        const details = { hostId: host.id, path: redactOutput(target), previewOnly: true, completeDiff: true, commitSupported: false,
          sourceSha256: prepared.sourceSha256, targetSha256: prepared.targetSha256,
          metadata: { mode: Number.isSafeInteger(snapshot.mode) && snapshot.mode >= 0 ? (snapshot.mode & 0o7777).toString(8) : null,
            uid: Number.isSafeInteger(snapshot.uid) && snapshot.uid >= 0 ? snapshot.uid : null,
            gid: Number.isSafeInteger(snapshot.gid) && snapshot.gid >= 0 ? snapshot.gid : null, aclXattr: 'unverified' },
          guidance: 'Preview only, not authorization or an editId. No lock is held. Re-read and re-prepare before any future supported commit; current SFTP replacement remains refused.' };
        const structuredContent = { ...details, diff: prepared.diff };
        if (Buffer.byteLength(JSON.stringify(structuredContent)) > 96 * 1024)
          return blocked('remote-edit-diff-too-large', 'Complete structured preview exceeds the output budget. No partial preview or write was produced.');
        return { readOnly: true, content: [{ type: 'text', text: `${JSON.stringify(details)}\n${prepared.diff}` }],
          details, structuredContent, isError: false };
      } catch (error) {
        return blocked('remote-edit-unavailable', `Preview unavailable; nothing written: ${redactOutput(error instanceof Error ? error.message : String(error))}`);
      }
    }
  };
}
