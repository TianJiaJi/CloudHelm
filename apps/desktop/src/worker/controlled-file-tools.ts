import { Type, type Static } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';
import type { FileEditService } from './file-edit-service.js';
import { blockedOperationFeedback } from './operation-feedback.js';
const identifier = Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
const editParameters = Type.Object({ editId: identifier }, { additionalProperties: false });
const recoveryParameters = Type.Object({ recoveryId: identifier }, { additionalProperties: false });
const checkParameters = Type.Object({ recoveryId: identifier, validator: Type.Union([
  Type.Literal('nginx'), Type.Literal('sshd'), Type.Literal('systemd-unit')]) }, { additionalProperties: false });
const unavailable = (id: string) => blockedOperationFeedback(id, 'file-transactions-unavailable', 'Controlled file transaction driver unavailable. No fallback to SFTP overwrite or Shell staging.');
const recoveryListParameters = Type.Object({ hostId: Type.String(), path: Type.String(),
  privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])) }, { additionalProperties: false });
const recoveryCleanupParameters = Type.Object({ hostId: Type.String(), path: Type.String(),
  names: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 16, uniqueItems: true }),
  privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])) }, { additionalProperties: false });
export function controlledFileTools(service?: FileEditService): BusinessTool<any>[] {
  const listRecovery: BusinessTool<Static<typeof recoveryListParameters>> = { name: 'list_remote_recovery', label: 'List private file recovery material',
    access: 'query', deferred: true, replay: 'never', available: () => !!service, parameters: recoveryListParameters,
    description: 'Read-only metadata listing (name/kind/size/mtime) of the private recovery container directory of one remote path: staged edit directories and backup files. Entry content stays unread. Root listing is a high-impact review. Use it before any cleanup; Shell enumeration stays outside this tool.',
    execute: async (id, args, signal) => service ? service.listRecovery(id, args, signal) : unavailable(id) };
  const cleanupRecovery: BusinessTool<Static<typeof recoveryCleanupParameters>> = { name: 'cleanup_remote_recovery', label: 'Clean named file recovery material',
    replay: 'never', available: () => !!service, parameters: recoveryCleanupParameters,
    description: 'Explicitly remove only the named recovery entries (from list_remote_recovery) inside one container directory. Every name is reviewed; unknown names are refused per item without stopping others. No live file is touched, and refused/missing names are settled outcomes. Recovery material that an unverified operation may still need stays in place.',
    execute: async (id, args, signal) => service ? service.cleanupRecovery(id, args, signal) : unavailable(id) };
  const apply: BusinessTool<Static<typeof editParameters>> = { name: 'apply_remote_edit', label: 'Commit an exact prepared file edit',
    replay: 'never', available: () => !!service, parameters: editParameters,
    description: 'Consume a backend editId from prepare_remote_edit exactly once. SafetyGate reviews exact path/content/diff/identity/metadata and current policy; authentication is private. Supported Linux metadata is preserved and read back, with an owner-private recovery entry. Changed or unsupported metadata fails closed. Unknown results call for inspection; retries with a new token or identity stay blocked.',
    execute: async (id, args, signal) => service ? service.apply(id, args.editId, signal) : unavailable(id) };
  const discard: BusinessTool<Static<typeof editParameters>> = { name: 'discard_remote_edit', label: 'Discard a local prepared file edit',
    replay: 'never', available: () => !!service, parameters: editParameters,
    description: 'Discard a task-local prepared editId. Preparation created no remote temporary file, and discarding leaves committed backups, file contents and unknown-operation state untouched.',
    execute: async (id, args) => service ? service.discard(args.editId) : unavailable(id) };
  const restore: BusinessTool<Static<typeof recoveryParameters>> = { name: 'restore_remote_edit', label: 'Restore one verified file version with new review',
    replay: 'never', available: () => !!service, parameters: recoveryParameters,
    description: 'Use the successful apply/restore operation ID as recoveryId. Re-inspects the current target and private original, rejects any changed/unconfirmed version, and requests a new exact SafetyGate review. Metadata and content are verified again. Unknown or in-flight work stays outside automatic restore, and service rollback is a separate manual concern.',
    execute: async (id, args, signal) => service ? service.restore(id, args.recoveryId, signal) : unavailable(id) };
  const check: BusinessTool<Static<typeof checkParameters>> = { name: 'check_remote_edit', label: 'Validate a verified edited configuration',
    replay: 'never', available: () => !!service, parameters: checkParameters,
    description: 'Use a successful file operation ID and a supported validator. Recheck exact current file version, then separately review fixed nginx -t, sshd -t or systemd-analyze verify for that bound path/identity. No arbitrary validator args, package installation or service restart. Exit 0 proves syntax only, not application health.',
    execute: async (id, args, signal) => service ? service.check(id, args.recoveryId, args.validator, signal) : unavailable(id) };
  return [apply, discard, restore, check, listRecovery, cleanupRecovery];
}
