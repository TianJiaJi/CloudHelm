import { randomUUID } from 'node:crypto';
import { OutputRedactor, prepareFileEdit, validRecoveryEntryName, type BusinessTool, type FileInspection, type FileRecovery, type OperationAdjudication, type OperationScope,
  type ProposedOperation } from '@cloudhelm/core';
import { validFileRecovery } from '@cloudhelm/adapters';
import type { SafetyGate } from '@cloudhelm/application';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { assertRemoteReadAllowed, resolveRemoteReadTarget } from './remote-read-guard.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { OperationPrivilege } from './operation-privilege.js';

type Reply = Awaited<ReturnType<BusinessTool<any>['execute']>>;
type Privilege = 'current' | 'root';
type Adjudications = OperationAdjudication[];
interface Read { privilege: Privilege; host: RuntimeHost; terminal: string; scope: OperationScope; snapshot: FileInspection; binding: string; expires: number }
interface Plan extends Read { content: string; diff: string; id: string }
const MAX_MEMORY = 8 * 1_048_576, TTL = 10 * 60_000;
const quote = (text: string) => `'${text.replace(/'/gu, `'"'"'`)}'`;
const adjudicationRequired = (feedback: Reply): boolean =>
  (feedback.details as { code?: unknown } | undefined)?.code === 'adjudication-required';

/** A deterministic non-dispatch refusal asking the proposer to re-propose with an
 * explicit confirmation; the original receipt must reach the caller untouched. */
class AdjudicationRequiredError extends Error {
  constructor(readonly feedback: Reply) { super('adjudication-required'); }
}

/** Backend-only authority. A prepared token is one-use, bounded, short-lived,
 * and bound to task/host/login/terminal/connection/policy/model generations. */
export class FileEditService {
  private readonly reads = new Map<string, Read>();
  private readonly plans = new Map<string, Plan>();
  private readonly consumedRecoveries = new Set<string>();
  private readonly privilege: OperationPrivilege;
  constructor(private readonly deps: RemoteToolDependencies, private readonly gate: SafetyGate) { this.privilege = new OperationPrivilege(deps); }
  private binding(host: RuntimeHost, terminal: string, privilege: Privilege): string {
    return JSON.stringify([this.deps.fileBinding?.(), host.id, host.username, host.policyRevision, host.archived,
      this.deps.scope(host, terminal, '/'), privilege]);
  }
  private clean(): void {
    for (const map of [this.reads, this.plans]) for (const [id, value] of map) {
      try {
        if (Date.now() >= value.expires || value.binding !== this.binding(value.host, value.terminal, value.privilege)) map.delete(id);
      } catch { map.delete(id); }
    }
  }
  private memory(): number {
    let bytes = 0;
    for (const value of this.reads.values()) bytes += Buffer.byteLength(value.snapshot.content);
    for (const value of this.plans.values()) bytes += Buffer.byteLength(value.snapshot.content) + Buffer.byteLength(value.content) + Buffer.byteLength(value.diff);
    return bytes;
  }
  private invalidate(hostId: string, filePath: string): void {
    for (const [key, value] of this.reads) if (value.host.id === hostId && value.snapshot.path === filePath) this.reads.delete(key);
  }
  private async inspect(hostId: string, filePath: string, privilege: Privilege, signal?: AbortSignal, recoveryDirectoryId?: string, adjudications?: Adjudications): Promise<Read> {
    this.clean(); signal?.throwIfAborted();
    const host = this.deps.hosts.find((item) => item.id === hostId && !item.archived);
    if (!host) throw new Error('File host is outside current task authorization');
    const target = resolveRemoteReadTarget(filePath, '/');
    assertRemoteReadAllowed(target, host.protectedReadPaths ?? host.protectedPaths ?? []);
    const terminal = await this.deps.ensureTerminal(host.id);
    const base = this.deps.scope(host, terminal, '/');
    if (base.sessionId) throw new Error('Use operation-level file privilege, not a legacy session');
    const scope = { ...base, runAs: privilege === 'root' ? 'root' : host.username, loginAs: host.username };
    const binding = this.binding(host, terminal, privilege);
    let snapshot: FileInspection | undefined;
    const operation: ProposedOperation = { id: randomUUID(), kind: 'inspect-file', path: target, scope,
      ...(privilege === 'root' ? { privilege: 'root' as const } : {}), ...(recoveryDirectoryId ? { recoveryDirectoryId } : {}),
      ...(adjudications ? { adjudications } : {}) };
    const outcome = await this.deps.runOperation(this.gate, operation, signal, host.label, (value) => { snapshot = value; });
    if (adjudicationRequired(outcome)) throw new AdjudicationRequiredError(outcome);
    signal?.throwIfAborted();
    if (outcome.isError || outcome.result?.status !== 'succeeded' || !snapshot) throw new Error('File inspection was refused, canceled or unconfirmed; do not switch identity or retry automatically');
    if (binding !== this.binding(host, terminal, privilege)) throw new Error('File inspection grant expired');
    const redactor = new OutputRedactor(1_048_576), safe = redactor.push(snapshot.content) + redactor.finish();
    if (safe !== snapshot.content) throw new Error('File needs private handling; content/hash is not delivered or editable');
    return { privilege, host, terminal, scope, snapshot, binding, expires: Date.now() + TTL };
  }
  async read(id: string, args: { hostId: string; path: string; privilege?: Privilege; maxBytes?: number; adjudications?: Adjudications }, signal?: AbortSignal): Promise<Reply> {
    try {
      const limit = args.maxBytes ?? 128 * 1024;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_048_576) throw new Error('Invalid read limit');
      const value = await this.inspect(args.hostId, args.path, args.privilege ?? 'current', signal, undefined, args.adjudications);
      const key = JSON.stringify([value.host.id, value.snapshot.path, args.privilege ?? 'current', value.snapshot.sha256]);
      this.reads.delete(key);
      if (this.reads.size >= 4 || this.memory() + Buffer.byteLength(value.snapshot.content) > MAX_MEMORY) throw new Error('File preparation memory limit reached; discard prepared edits before reading more');
      this.reads.set(key, value);
      const bytes = Buffer.from(value.snapshot.content); let end = Math.min(bytes.length, limit);
      while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      const content = bytes.subarray(0, end).toString('utf8'), truncated = end < bytes.length;
      const { content: _private, ...observed } = value.snapshot;
      const metadata = { ...observed, truncated, sha256: truncated ? undefined : observed.sha256,
        metadataDigest: truncated ? undefined : observed.metadataDigest, commitSupported: !truncated && observed.commitSupported };
      return { content: [{ type: 'text', text: `${JSON.stringify(metadata)}\n${content}` }], details: metadata, structuredContent: { ...metadata, content } };
    } catch (error) { if (error instanceof AdjudicationRequiredError) return error.feedback;
      return blockedOperationFeedback(id, 'file-inspection-unavailable', 'Private file inspection unavailable or refused. No content delivered; use explicit user direction, never automatic identity fallback.', undefined, true); }
  }
  async prepare(id: string, args: { hostId: string; path: string; privilege?: Privilege; expectedSha256: string; oldText: string; newText: string; adjudications?: Adjudications }, signal?: AbortSignal): Promise<Reply> {
    try {
      this.clean(); const privilege = args.privilege ?? 'current', target = resolveRemoteReadTarget(args.path, '/');
      const key = JSON.stringify([args.hostId, target, privilege, args.expectedSha256]);
      const observed = this.reads.get(key) ?? await this.inspect(args.hostId, target, privilege, signal, undefined, args.adjudications);
      const preview = prepareFileEdit({ content: observed.snapshot.content, sha256: observed.snapshot.sha256, truncated: false }, args.expectedSha256, args.oldText, args.newText);
      if (preview.kind === 'refused') return blockedOperationFeedback(id, preview.code, preview.message, undefined, true);
      signal?.throwIfAborted();
      if (observed.binding !== this.binding(observed.host, observed.terminal, privilege)) throw new Error('Preparation grant expired');
      const metadata = { ...observed.snapshot, content: undefined }, complete = observed.snapshot.commitSupported;
      let editId: string | undefined;
      if (complete) {
        if (this.plans.size >= 4 || this.memory() + Buffer.byteLength(preview.content) + Buffer.byteLength(preview.diff) + Buffer.byteLength(observed.snapshot.content) > MAX_MEMORY)
          throw new Error('Preparation capacity exceeded');
        editId = randomUUID();
        this.plans.set(editId, { ...observed, expires: Date.now() + TTL, content: preview.content, diff: preview.diff, id: editId });
      }
      const data = { previewOnly: !complete, commitSupported: complete, ...(editId ? { editId, expiresAt: Date.now() + TTL } : {}),
        hostId: observed.host.id, path: target, privilege, sourceSha256: preview.sourceSha256, targetSha256: preview.targetSha256,
        metadata, completeDiff: true, diff: preview.diff,
        guidance: complete ? 'Apply only this backend editId. Approval, credentials, source identity and metadata are rechecked; unknown results must not be replayed.'
          : 'No commit token: metadata completeness/atomic exchange is unsupported for this identity or host. Do not silently change identity, discard attributes or bypass via Shell.' };
      if (Buffer.byteLength(JSON.stringify(data)) > 96 * 1024) { if (editId) this.plans.delete(editId); throw new Error('Preview output budget exceeded'); }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: data };
    } catch (error) { if (error instanceof AdjudicationRequiredError) return error.feedback;
      return blockedOperationFeedback(id, 'file-preparation-unavailable', 'Preparation unavailable, expired, canceled or over budget. Nothing written; no new authority granted.', undefined, true); }
  }
  async apply(id: string, editId: string, signal?: AbortSignal, adjudications?: Adjudications): Promise<Reply> {
    this.clean(); const plan = this.plans.get(editId);
    if (!plan) return blockedOperationFeedback(id, 'file-edit-expired', 'Unknown, expired, consumed or revoked editId. Prepare again only when authorized; never replay an unknown operation.');
    this.plans.delete(editId); // Consumed before review/dispatch, including denial, cancellation and unknown outcomes.
    this.invalidate(plan.host.id, plan.snapshot.path);
    try {
      const privilege = plan.privilege;
      if (plan.binding !== this.binding(plan.host, plan.terminal, privilege)) throw new Error('Edit grant expired');
      const operation: ProposedOperation = { id: randomUUID(), kind: 'write-file', path: plan.snapshot.path, content: plan.content,
        scope: plan.scope, expectedSha256: plan.snapshot.sha256, ...(privilege === 'root' ? { privilege: 'root' as const } : {}), fileEdit: {
          version: 1, action: 'apply', transactionId: randomUUID(), expectedMetadataDigest: plan.snapshot.metadataDigest,
          expectedAttributeDigest: plan.snapshot.attributeDigest, expectedExecutionUid: plan.snapshot.executionUid, diff: plan.diff },
        ...(adjudications ? { adjudications } : {}) };
      const outcome = await this.deps.runOperation(this.gate, operation, signal, plan.host.label);
      // An adjudication-required refusal is deterministic and dispatch-free: the
      // token stays usable for the explicit re-proposal the receipt asks for.
      if (adjudicationRequired(outcome)) this.plans.set(editId, plan);
      return outcome;
    } catch { return blockedOperationFeedback(id, 'file-edit-expired', 'Edit authority expired; nothing dispatched. Re-prepare after explicit user direction.'); }
  }
  discard(editId: string): Reply {
    this.plans.delete(editId);
    return { content: [{ type: 'text', text: 'Local prepared edit discarded; no remote staging or file change was made.' }], details: { discarded: true } };
  }
  /** Recovery material lives in the private container directory; the same host,
   * read guard and generation bindings as an inspection apply, but no content
   * is ever delivered and the container itself is never opened through Shell. */
  private async recoveryScope(hostId: string, path: string, privilege: Privilege, signal?: AbortSignal) {
    this.clean(); signal?.throwIfAborted();
    const host = this.deps.hosts.find((item) => item.id === hostId && !item.archived);
    if (!host) throw new Error('File host is outside current task authorization');
    const target = resolveRemoteReadTarget(path, '/');
    assertRemoteReadAllowed(target, host.protectedReadPaths ?? host.protectedPaths ?? []);
    const terminal = await this.deps.ensureTerminal(host.id);
    const base = this.deps.scope(host, terminal, '/');
    if (base.sessionId) throw new Error('Use operation-level file privilege, not a legacy session');
    const scope = { ...base, runAs: privilege === 'root' ? 'root' : host.username, loginAs: host.username };
    return { host, target, scope };
  }
  /** Read-only metadata listing of one container; never includes entry content. */
  async listRecovery(id: string, args: { hostId: string; path: string; privilege?: Privilege; adjudications?: Adjudications }, signal?: AbortSignal): Promise<Reply> {
    try {
      const privilege = args.privilege ?? 'current';
      const { host, target, scope } = await this.recoveryScope(args.hostId, args.path, privilege, signal);
      const operation: ProposedOperation = { id: randomUUID(), kind: 'list-recovery', path: target, scope,
        ...(privilege === 'root' ? { privilege: 'root' as const } : {}),
        ...(args.adjudications ? { adjudications: args.adjudications } : {}) };
      return this.deps.runOperation(this.gate, operation, signal, host.label);
    } catch { return blockedOperationFeedback(id, 'recovery-listing-unavailable', 'Recovery listing unavailable or refused. No fallback to Shell enumeration; wait for explicit user direction.', undefined, true); }
  }
  /** Explicit, per-name cleanup of recovery material; every name needs its own review. */
  async cleanupRecovery(id: string, args: { hostId: string; path: string; names: string[]; privilege?: Privilege; adjudications?: Adjudications }, signal?: AbortSignal): Promise<Reply> {
    try {
      const privilege = args.privilege ?? 'current';
      const names = args.names;
      if (!Array.isArray(names) || names.length < 1 || names.length > 16 || names.some((name) => !validRecoveryEntryName(name)))
        throw new Error('Invalid recovery entry names');
      const { host, target, scope } = await this.recoveryScope(args.hostId, args.path, privilege, signal);
      const operation: ProposedOperation = { id: randomUUID(), kind: 'cleanup-recovery', path: target, names, scope,
        ...(privilege === 'root' ? { privilege: 'root' as const } : {}),
        ...(args.adjudications ? { adjudications: args.adjudications } : {}) };
      return this.deps.runOperation(this.gate, operation, signal, host.label);
    } catch { return blockedOperationFeedback(id, 'recovery-cleanup-unavailable', 'Recovery cleanup unavailable, refused or invalid. Nothing deleted; no fallback to Shell rm.'); }
  }
  private recovery(id: string) {
    const operation = this.deps.fileOperations?.().find((item) => item.id === id);
    if (!operation || !this.deps.hosts.some((host) => host.id === operation.hostId) || operation.status !== 'succeeded' || !validFileRecovery(operation.fileRecovery) || this.consumedRecoveries.has(id))
      throw new Error('Recovery receipt unavailable or outcome not confirmed');
    return { operation, receipt: operation.fileRecovery as FileRecovery };
  }
  async restore(id: string, recoveryId: string, signal?: AbortSignal, adjudications?: Adjudications): Promise<Reply> {
    try {
      const { operation: prior, receipt } = this.recovery(recoveryId), privilege = prior.runAs === 'root' ? 'root' : 'current';
      const live = await this.inspect(prior.hostId, receipt.path, privilege, signal, undefined, adjudications);
      if (live.snapshot.sha256 !== receipt.afterSha256 || live.snapshot.metadataDigest !== receipt.afterMetadataDigest)
        throw new Error('Current target changed after commit');
      const backup = await this.inspect(prior.hostId, receipt.path, privilege, signal, receipt.directoryId, adjudications);
      if (backup.snapshot.sha256 !== receipt.beforeSha256 || backup.snapshot.metadataDigest !== receipt.beforeMetadataDigest)
        throw new Error('Recovery entry changed');
      const diff = prepareFileEdit({ content: live.snapshot.content, sha256: live.snapshot.sha256, truncated: false }, live.snapshot.sha256, live.snapshot.content, backup.snapshot.content);
      if (diff.kind !== 'prepared') throw new Error('Restore diff is unavailable');
      if (live.binding !== this.binding(live.host, live.terminal, privilege)) throw new Error('Restore grant expired');
      if (this.consumedRecoveries.size >= 256) throw new Error('Recovery grant capacity reached');
      this.consumedRecoveries.add(recoveryId);
      this.invalidate(prior.hostId, receipt.path);
      const operation: ProposedOperation = { id: randomUUID(), kind: 'write-file', path: receipt.path, content: backup.snapshot.content,
        scope: live.scope, expectedSha256: live.snapshot.sha256, ...(privilege === 'root' ? { privilege: 'root' as const } : {}), fileEdit: {
          version: 1, action: 'restore', transactionId: randomUUID(), backupTransactionId: receipt.directoryId,
          expectedBackupMetadataDigest: receipt.beforeMetadataDigest, expectedMetadataDigest: live.snapshot.metadataDigest,
          expectedAttributeDigest: backup.snapshot.attributeDigest, expectedExecutionUid: live.snapshot.executionUid, diff: diff.diff },
        ...(adjudications ? { adjudications } : {}) };
      const outcome = await this.deps.runOperation(this.gate, operation, signal, live.host.label);
      // An adjudication-required refusal is deterministic and dispatch-free: the
      // recovery stays restorable for the explicit re-proposal the receipt asks for.
      if (adjudicationRequired(outcome)) this.consumedRecoveries.delete(recoveryId);
      return outcome;
    } catch (error) { if (error instanceof AdjudicationRequiredError) return error.feedback;
      return blockedOperationFeedback(id, 'file-recovery-unavailable', 'Recovery refused: source/backup/outcome/authority changed or was unconfirmed. Nothing dispatched; never restore unknown work automatically.'); }
  }
  async check(id: string, recoveryId: string, validator: 'nginx' | 'sshd' | 'systemd-unit', signal?: AbortSignal, adjudications?: Adjudications): Promise<Reply> {
    try {
      const { operation, receipt } = this.recovery(recoveryId), privilege = operation.runAs === 'root' ? 'root' : 'current';
      const live = await this.inspect(operation.hostId, receipt.path, privilege, signal, undefined, adjudications);
      if (live.snapshot.sha256 !== receipt.afterSha256 || live.snapshot.metadataDigest !== receipt.afterMetadataDigest) throw new Error('Configuration changed');
      if (!['nginx', 'sshd', 'systemd-unit'].includes(validator)) throw new Error('Unsupported validator');
      const prefix = { nginx: '/usr/sbin/nginx -t -c', sshd: '/usr/sbin/sshd -t -f', 'systemd-unit': '/usr/bin/systemd-analyze verify --' }[validator];
      if (!prefix) throw new Error('Unsupported validator');
      const command: Extract<ProposedOperation, { kind: 'command' }> = { id: randomUUID(), kind: 'command',
        command: `${prefix} ${quote(receipt.path)}`, scope: this.deps.scope(live.host, live.terminal, '/'),
        ...(adjudications ? { adjudications } : {}) };
      const pending = privilege === 'root' ? this.privilege.run(this.gate, live.host, command, signal)
        : this.deps.runOperation(this.gate, command, signal, live.host.label);
      return pending.then((outcome) => ({ ...outcome, content: [...outcome.content, { type: 'text' as const,
        text: 'Configuration syntax observation only, not service restart, health or whole-task success. Unknown validation is not replayed automatically.' }] }));
    } catch { return blockedOperationFeedback(id, 'file-config-check-unavailable', 'Configuration check refused: receipt/target/identity unavailable or changed. No validator was dispatched.'); }
  }
}
