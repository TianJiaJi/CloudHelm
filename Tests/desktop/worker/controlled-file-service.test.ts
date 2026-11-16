import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BashAnalyzer, FileTransactionRunner, type SshTransport } from '@cloudhelm/adapters';
import { HostSerialExecutor, SafetyGate, TerminalManager } from '@cloudhelm/application';
import { operationFingerprint, operationIntentKey, type FileInspection, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { operationPreview } from '../../../apps/desktop/src/worker/operation-preview.js';
import { FileEditService } from '../../../apps/desktop/src/worker/file-edit-service.js';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let state: FileInspection = { version: 1, path: '/srv/config', content: 'port=80\n', sha256: hash('port=80\n'),
    metadataDigest: 'a'.repeat(64), attributeDigest: 'f'.repeat(64), executionUid: 0, uid: 37, gid: 42, mode: 0o640,
    size: 8, device: '10', inode: '1', commitSupported: true, limitation: '' };
  let backup: FileInspection | undefined, generation = 'initial', allowed = true, unknown = false;
  const operations: OperationView[] = [], dispatched: ProposedOperation[] = [];
  const terminal = new TerminalManager({ data() {}, state() {} });
  const terminalId = terminal.open('host', { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, 'task', '/');
  const host: RuntimeHost = { id: 'host', username: 'user', label: 'fixture', policyRevision: 1, protectedPaths: [], defaultMode: 'ask',
    status: 'connected', address: '192.0.2.1', port: 22, auth: 'agent' };
  const scope = (): OperationScope => ({ taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', loginAs: 'user',
    terminalId, terminalGeneration: terminal.currentGeneration(terminalId), policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'edit and explicitly restore' });
  const driver = vi.spyOn(FileTransactionRunner.prototype, 'run').mockImplementation(async (operation) => {
    dispatched.push(structuredClone(operation));
    if (operation.kind === 'inspect-file') return { status: 'inspected', snapshot: structuredClone(operation.recoveryDirectoryId ? backup! : state) };
    if (operation.kind !== 'write-file' || !operation.fileEdit || operation.expectedSha256 !== state.sha256 || operation.fileEdit.expectedMetadataDigest !== state.metadataDigest)
      return { status: 'refused', effects: 'none', code: 'source-version-or-metadata-changed' };
    if (unknown) return { status: 'unknown', effects: 'possible', code: 'private-channel-interrupted' };
    const before = structuredClone(state);
    state = { ...(operation.fileEdit.action === 'restore' ? backup! : state), content: operation.content,
      sha256: hash(operation.content), metadataDigest: 'b'.repeat(64), inode: operation.fileEdit.action === 'restore' ? '1' : '2' };
    backup = { ...before, metadataDigest: 'c'.repeat(64) };
    return { status: 'committed', snapshot: state, recovery: { version: 1, directoryId: operation.fileEdit.backupTransactionId ?? operation.fileEdit.transactionId,
      path: state.path, beforeSha256: before.sha256, beforeMetadataDigest: backup.metadataDigest,
      afterSha256: state.sha256, afterMetadataDigest: state.metadataDigest } };
  });
  const commands = { execute: vi.fn(async (operation: ProposedOperation) => ({ operationId: operation.id, status: 'succeeded' as const,
    exitCode: 0, effects: 'none' as const, stdoutTail: operation.kind === 'command' && operation.command === 'id -u' ? '0\n' : 'syntax valid' })) };
  const executor = new HostSerialExecutor(new FileOperationExecutor(terminal, { connectionGeneration: () => 1 } as unknown as SshTransport, commands));
  const approvals = vi.fn(async () => allowed);
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: approvals },
    executor, lease: { isAgentOwner: (id) => terminal.isAgentOwner(id), currentGeneration: (id) => terminal.currentGeneration(id) },
    settings: () => ({ revision: 1, mode: 'ask' }), audit: {
      proposed: async (operation) => { operations.push({ id: operation.id, taskId: 'task', hostId: 'host', kind: operation.kind,
        preview: operationPreview(operation), status: 'proposed', createdAt: Date.now(), runAs: operation.scope.runAs }); },
      classified: async (id, readOnly) => { operations.find((item) => item.id === id)!.readOnly = readOnly; },
      decided: async (id, decision) => { Object.assign(operations.find((item) => item.id === id)!, { ruleId: decision.ruleId, status: decision.verdict === 'allow' ? 'running' : 'denied' }); },
      completed: async (result) => { Object.assign(operations.find((item) => item.id === result.operationId)!, result); }
    } });
  const deps: RemoteToolDependencies = { taskId: 'task', hosts: [host], controlledFiles: true, localFiles: new LocalFileAccess([]),
    ensureTerminal: async () => terminalId, scope, fileBinding: () => generation, fileOperations: () => operations,
    runOperation: async (target, operation, signal, _label, onFileInspection) => {
      const outcome = await target.execute(operation, signal, false, { onFileInspection });
      return { ...outcome, content: [{ type: 'text', text: outcome.result?.stdoutTail ?? outcome.decision.reason }],
        details: {}, isError: outcome.result?.status !== 'succeeded' };
    } };
  const service = new FileEditService(deps, gate);
  const args = () => ({ hostId: 'host', path: '/srv/config', privilege: 'root' as const, expectedSha256: state.sha256, oldText: '80', newText: '90' });
  const prepare = async () => {
    const result = await service.prepare('prepare', args());
    expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ commitSupported: true, previewOnly: false });
    return (result.structuredContent as { editId: string }).editId;
  };
  return { service, args, prepare, driver, dispatched, operations, commands, approvals, scope,
    state: () => state, mutate: () => { state = { ...state, metadataDigest: 'd'.repeat(64) }; },
    revoke: () => { generation = 'changed'; }, deny: () => { allowed = false; }, unknown: () => { unknown = true; } };
}
it('performs read -> prepare -> exact gate commit -> syntax check -> newly reviewed metadata-preserving restore', async () => {
  const f = fixture();
  expect((await f.service.read('read', { hostId: 'host', path: '/srv/config', privilege: 'root' })).isError).not.toBe(true);
  const editId = await f.prepare();
  expect(f.dispatched).toHaveLength(1); // Preparation reused the bound private observation, no second authentication/read.
  const result = await f.service.apply('apply', editId);
  expect(result.isError).toBe(false); expect(f.state().content).toBe('port=90\n'); expect(f.state().mode).toBe(0o640);
  const committed = f.operations.find((item) => item.kind === 'write-file')!;
  expect(committed.fileRecovery?.beforeSha256).toBe(hash('port=80\n'));
  expect(committed.fileRecovery?.afterSha256).toBe(hash('port=90\n'));
  expect((await f.service.check('check', committed.id, 'nginx')).isError).toBe(false);
  expect(f.commands.execute.mock.calls.some(([operation]) => operation.kind === 'command' && operation.command === "/usr/sbin/nginx -t -c '/srv/config'")).toBe(true);
  expect((await f.service.restore('restore', committed.id)).isError).toBe(false);
  expect(f.state().content).toBe('port=80\n'); expect(f.state().attributeDigest).toBe('f'.repeat(64));
  expect(f.dispatched.filter((item) => item.kind === 'write-file')).toHaveLength(2);
  expect(f.approvals.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect((await f.service.restore('duplicate', committed.id)).isError).toBe(true);
});
it.each(['expired', 'revoked', 'denied', 'changed', 'unknown'] as const)('never reuses an edit token or bypasses %s', async (mode) => {
  const f = fixture(), editId = await f.prepare();
  if (mode === 'revoked') f.revoke();
  if (mode === 'denied') f.deny();
  if (mode === 'changed') f.mutate();
  if (mode === 'unknown') f.unknown();
  const now = mode === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000) : undefined;
  try {
    expect((await f.service.apply('first', editId)).isError).toBe(true);
    const count = f.dispatched.length;
    expect((await f.service.apply('duplicate', editId)).isError).toBe(true);
    expect(f.dispatched).toHaveLength(count);
    expect(f.state().content).toBe('port=80\n');
    if (mode === 'unknown') {
      const operation = f.operations.find((item) => item.kind === 'write-file')!;
      expect(operation).toMatchObject({ status: 'unknown', effects: 'possible' });
      expect((await f.service.restore('not-confirmed', operation.id)).isError).toBe(true);
    }
  } finally { now?.mockRestore(); }
});
it('does not let transaction IDs change replay identity, while exact approval binds them', async () => {
  const f = fixture(), editId = await f.prepare(); await f.service.apply('apply', editId);
  const first = f.dispatched.find((item) => item.kind === 'write-file')!;
  if (first.kind !== 'write-file' || !first.fileEdit) throw new Error('missing commit');
  const second: ProposedOperation = { ...first, fileEdit: { ...first.fileEdit, transactionId: '00000000-0000-4000-8000-000000000001' } };
  expect(operationFingerprint(second)).not.toBe(operationFingerprint(first));
  expect(operationIntentKey(second)).toBe(operationIntentKey(first));
});
