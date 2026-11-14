import { afterEach, expect, it, vi } from 'vitest';
import { SshTransport } from '@cloudhelm/adapters';
import type { OperationView, RemoteReadAuditEvent } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { securityWorker } from './security-worker-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());
const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };

it.each(['requested', 'authorized', 'completed', 'denied'] as RemoteReadAuditEvent['phase'][])('fails closed on a real Main/SQLite audit-write failure at %s', async (phase) => {
  const f = await securityWorker(host);
  const target = phase === 'denied' ? '/srv/app/.env' : '/srv/app/plain.txt';
  const body = 'synthetic-file-body-must-not-reach-model';
  const read = vi.spyOn(SshTransport.prototype, 'readFileForEdit').mockResolvedValue({ content: body,
    sha256: 'a'.repeat(64), bytes: body.length, truncated: false, mode: 0o600, uid: 1000, gid: 1000 });
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementation((bucket, id, value) => {
    const op = value as OperationView;
    if (bucket === 'operations' && op.readAudit?.events.at(-1)?.phase === phase)
      throw new Error('synthetic-private-storage-detail');
    return put(bucket, id, value);
  });
  let requests = 0;
  const model = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'discover', name: 'tool_search', arguments: { query: 'read_remote_file', limit: 1 } }] };
    if (requests === 2) return { calls: [{ id: 'read-fault', name: 'read_remote_file', arguments: { hostId: host.id, path: target } }] };
    return { text: '审计未确认，未收到文件内容。' };
  });
  try {
    const task = f.task('读取配置');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]); expect(requests).toBe(3);
    const result = model.requests[2]!.messages.find((message) => message.tool_call_id === 'read-fault');
    expect(fixtureMessageText(result!)).toContain('持久化确认');
    expect(read).toHaveBeenCalledTimes(phase === 'completed' ? 1 : 0);
    expect(JSON.stringify(model.requests)).not.toContain(body);
    expect(JSON.stringify(model.requests)).not.toContain('synthetic-private-storage-detail');
    expect(JSON.stringify(f.store.list('operations'))).not.toContain(body);
  } finally { await model.close(); await f.close(); }
});

it('persists an out-of-scope host denial without touching SFTP', async () => {
  const f = await securityWorker(host);
  const read = vi.spyOn(SshTransport.prototype, 'readFileForEdit');
  let requests = 0;
  const model = await openAiFixture(async () => ++requests === 1
    ? { calls: [{ id: 'discover', name: 'tool_search', arguments: { query: 'read_remote_file', limit: 1 } }] }
    : requests === 2 ? { calls: [{ id: 'foreign', name: 'read_remote_file', arguments: { hostId: 'foreign-host', path: '/srv/plain.txt' } }] }
      : { text: '主机不在授权范围内。' });
  try {
    const task = f.task('检查读取范围');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(f.store.list<OperationView>('operations')).toEqual([expect.objectContaining({ taskId: task.id,
      hostId: 'foreign-host', kind: 'read-file', status: 'denied', ruleId: 'read-host-out-of-scope' })]);
  } finally { await model.close(); await f.close(); }
});
