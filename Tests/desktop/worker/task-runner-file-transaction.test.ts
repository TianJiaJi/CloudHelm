import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalManager, HostSerialExecutor } from '@cloudhelm/application';
import { FileTransactionRunner, type SshTransport } from '@cloudhelm/adapters';
import type { FileInspection } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { FileOperationExecutor } from '../../../apps/desktop/src/worker/file-operation-executor.js';
import { validateOperationView } from '../../../apps/desktop/src/main/operation-view-validation.js';
import { TaskRunner, type TaskSignals } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.restoreAllMocks());
it('uses native discovery and the production task/gate/file executor chain for reviewed apply and explicit restore', async () => {
  let state: FileInspection = { version: 2, path: '/srv/config', content: 'port=80\n', sha256: hash('port=80\n'), metadataDigest: 'a'.repeat(64),
    attributeDigest: 'f'.repeat(64), executionUid: 0, uid: 37, gid: 42, mode: 0o640, size: 8,
    commitSupported: true, limitation: '' };
  let backup: FileInspection | undefined;
  const driver = vi.spyOn(FileTransactionRunner.prototype, 'run').mockImplementation(async (operation) => {
    if (operation.kind === 'inspect-file') return { status: 'inspected', snapshot: structuredClone(operation.recoveryDirectoryId ? backup! : state) };
    if (operation.kind !== 'write-file' || !operation.fileEdit) return { status: 'refused', effects: 'none', code: 'unexpected-operation' };
    expect(operation.expectedSha256).toBe(state.sha256);
    const previous = state;
    state = { ...(operation.fileEdit.action === 'restore' ? backup! : state), content: operation.content, sha256: hash(operation.content), metadataDigest: 'b'.repeat(64) };
    backup = { ...previous, metadataDigest: 'c'.repeat(64) };
    return { status: 'committed', snapshot: state, recovery: { version: 1, directoryId: operation.fileEdit.backupTransactionId ?? operation.fileEdit.transactionId,
      path: state.path, beforeSha256: previous.sha256, beforeMetadataDigest: backup.metadataDigest, afterSha256: state.sha256, afterMetadataDigest: state.metadataDigest } };
  });
  let requests = 0;
  const model = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1 || requests === 3) return { calls: [{ id: `discover-${requests}`, name: 'tool_search',
      arguments: { query: requests === 1 ? 'read_remote_file' : 'prepare_remote_edit', limit: 1 } }] };
    if (requests === 2) return { calls: [{ id: 'read', name: 'read_remote_file', arguments: { hostId: 'host', path: '/srv/config', privilege: 'root' } }] };
    if (requests === 4) return { calls: [{ id: 'prepare', name: 'prepare_remote_edit', arguments: { hostId: 'host', path: '/srv/config', privilege: 'root',
      expectedSha256: hash('port=80\n'), oldText: '80', newText: '90' } }] };
    const text = fixtureMessageText(request.messages.filter((message) => message.role === 'tool').at(-1)!);
    if (requests === 5) {
      const editId = /"editId":"([a-f0-9-]+)"/u.exec(text)?.[1]; expect(editId).toBeTruthy();
      return { calls: [{ id: 'apply', name: 'apply_remote_edit', arguments: { editId } }] };
    }
    if (requests === 6) {
      expect(state.content).toBe('port=90\n'); const recoveryId = /Operation ID: ([a-f0-9-]+)/u.exec(text)?.[1]; expect(recoveryId).toBeTruthy();
      return { calls: [{ id: 'restore', name: 'restore_remote_edit', arguments: { recoveryId } }] };
    }
    expect(text).toContain('Status: succeeded');
    return { text: '已按完整差异提交，随后经新审核恢复原版本；元数据已读回核验，未启动服务，未据此宣称服务健康。' };
  });
  const host: RuntimeHost = { id: 'host', label: 'fixture', username: 'user', address: '192.0.2.1', port: 22,
    auth: 'agent', status: 'connected', defaultMode: 'ask', policyRevision: 1, protectedPaths: [] };
  const task: TaskView = { id: 'file-task', goal: '把端口改成90，再显式恢复原配置；不启动服务', hostIds: ['host'], localScopes: [],
    status: 'draft', provider: 'cloudhelm-custom', modelId: 'fixture', requestCount: 0, requestLimit: 12, createdAt: 1, updatedAt: 1 };
  const terminals = new TerminalManager({ data() {}, state() {} });
  const open = vi.fn(async () => terminals.open('host', { write() {}, resize() {}, close() {}, onData() {}, onClose() {} }, task.id, '/'));
  const ordinary = { execute: vi.fn() };
  const executor = new HostSerialExecutor(new FileOperationExecutor(terminals, { connectionGeneration: () => 1 } as unknown as SshTransport, ordinary));
  const requestApproval = vi.fn(async () => true), records = new Map<string, OperationView>();
  const events: Parameters<TaskSignals['event']>[0][] = [];
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl },
    [], terminals, executor, open, { event: (event) => events.push(structuredClone(event)), requestApproval, cancelApproval() {},
      commitOperation: async (value) => { validateOperationView(value); records.set(value.id, structuredClone(value)); } });
  try {
    await runner.start(); expect(model.errors).toEqual([]); expect(requests).toBe(7); expect(task.status).toBe('answered');
    expect(state.content).toBe('port=80\n'); expect(ordinary.execute).not.toHaveBeenCalled();
    expect(driver.mock.calls.filter(([operation]) => operation.kind === 'write-file')).toHaveLength(2);
    const writes = [...records.values()].filter((operation) => operation.kind === 'write-file');
    expect(writes).toHaveLength(2); expect(writes.every((operation) => operation.status === 'succeeded' && operation.fileRecovery)).toBe(true);
    expect(writes[0]!.preview).toContain('-port=80'); expect(writes[0]!.preview).toContain('+port=90');
    expect(writes[1]!.preview).toContain('-port=90'); expect(writes[1]!.preview).toContain('+port=80');
    expect(requestApproval.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect([...records.values()].filter((operation) => operation.kind === 'inspect-file').every((operation) => !operation.outputTail?.includes('port='))).toBe(true);
  } finally { await runner.close(); await model.close(); }
});
