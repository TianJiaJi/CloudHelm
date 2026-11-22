import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProposedOperation } from './model.js';
import type { FileStartTarget } from './ports.js';

/** The reviewed structured-write destination for upload / write-file without a
 * file transaction / delete-path. Controlled file transactions and read-only
 * file kinds have no structured write handoff and return undefined. The path
 * is resolved against the operation's own scope, so the gate's minted binding
 * and the executor's dispatch check share one resolution rule. */
export function structuredFileTargetOf(operation: ProposedOperation): FileStartTarget | undefined {
  if (operation.kind !== 'upload' && operation.kind !== 'write-file' && operation.kind !== 'delete-path') return undefined;
  if (operation.kind === 'write-file' && operation.fileEdit) return undefined;
  return {
    hostId: operation.scope.hostId,
    path: path.posix.resolve(operation.scope.cwd,
      operation.kind === 'upload' ? operation.remotePath : operation.path),
    operationKind: operation.kind,
    ...(operation.kind === 'upload' ? { contentSha256: operation.contentSha256 }
      : operation.kind === 'write-file'
        ? { contentSha256: createHash('sha256').update(operation.content, 'utf8').digest('hex') }
        : {}),
  };
}
