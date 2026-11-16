import path from 'node:path';
import type { FileTransactionRunner } from '@cloudhelm/adapters';
import type { ExecutionOptions, OperationResult, ProposedOperation } from '@cloudhelm/core';

type Operation = Extract<ProposedOperation, { kind: 'inspect-file' | 'write-file' | 'list-recovery' | 'cleanup-recovery' }>;
export async function executeControlledFile(driver: FileTransactionRunner, operation: Operation, current: () => boolean,
  signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
  const reply = await driver.run(operation, current, signal);
  const readOnly = operation.kind === 'inspect-file' || operation.kind === 'list-recovery';
  const recovery = reply.recovery;
  const location = recovery ? path.posix.join(path.posix.dirname(operation.path), `.cloudhelm-edit-${recovery.directoryId}`, 'entry')
    : operation.kind === 'write-file' && operation.fileEdit ? path.posix.join(path.posix.dirname(operation.path),
      `.cloudhelm-edit-${operation.fileEdit.backupTransactionId ?? operation.fileEdit.transactionId}`, 'entry') : undefined;
  if (reply.status === 'inspected' && reply.snapshot && current()) {
    options?.onFileInspection?.(reply.snapshot);
    return { operationId: operation.id, status: 'succeeded', exitCode: 0, effects: 'none', stdoutTail: 'Private file inspection completed; content is delivered only to the bound read handler.' };
  }
  // Metadata-only listing bound to the reviewed container; capped so the model-facing
  // receipt stays far below the tool-reply bound even at the driver's 128-row limit.
  if (reply.status === 'listed' && reply.entries && current()) {
    let receipt = JSON.stringify({ status: 'listed', path: operation.path,
      truncated: reply.truncated === true, entries: reply.entries });
    if (receipt.length > 28_000) {
      const shown = reply.entries.slice(0, 64);
      receipt = JSON.stringify({ status: 'listed', path: operation.path, truncated: true,
        entries: shown, omitted: reply.entries.length - shown.length });
    }
    return { operationId: operation.id, status: 'succeeded', exitCode: 0, effects: 'none', stdoutTail: receipt };
  }
  // Every requested name gets one definitive row; removals are business effects,
  // refused/missing rows are settled outcomes, so no row leaves the result unknown.
  if (reply.status === 'cleaned' && reply.items && current()) {
    const removed = reply.items.filter((item) => item.result === 'removed').length;
    return { operationId: operation.id, status: 'succeeded', exitCode: 0, effects: removed === 0 ? 'none' : 'possible',
      stdoutTail: JSON.stringify({ status: 'cleaned', path: operation.path, removed, items: reply.items }) };
  }
  if (reply.status === 'committed' && recovery && current()) return { operationId: operation.id, status: 'succeeded', exitCode: 0,
    fileRecovery: recovery, stdoutTail: `Exact content and owner/group/mode/ACL/xattr verified after atomic publication. Private metadata-preserving recovery entry: ${location}. Restore requires a new exact approval; this is not a service rollback.` };
  const effects = readOnly || reply.status === 'refused' && reply.effects === 'none' ? 'none' : 'possible';
  return { operationId: operation.id, status: effects === 'none' ? 'failed' : 'unknown', effects,
    failureKind: reply.authenticationFailed ? 'authentication-failed' : effects === 'none' ? 'not-dispatched' : 'unknown',
    ...(reply.authenticationFailed ? { requiresUserAction: true } : {}), ...(recovery ? { fileRecovery: recovery } : {}),
    stdoutTail: effects === 'none' ? `No file change: ${reply.code ?? 'inspection authorization expired'}. Re-prepare only when authorized; never switch identity after authentication cancellation.`
      : `File transaction outcome needs verification; do not replay or restore automatically. Inspect the original operation and possible private recovery entry: ${location ?? 'unavailable'}.` };
}
