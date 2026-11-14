import { afterEach, expect, it, vi } from 'vitest';
import { SshTransport, type ReadFileSnapshot } from '@cloudhelm/adapters';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { securityWorker } from './security-worker-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());

it('revokes an in-flight read before delivery and applies a custom secret path to the next read', async () => {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
  const target = '/home/app/config/secret.yaml';
  const f = await securityWorker(host);
  let release!: (snapshot: ReadFileSnapshot) => void;
  const read = vi.spyOn(SshTransport.prototype, 'readFileForEdit').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const snapshot: ReadFileSnapshot = { content: 'fixture-content-not-for-delivery', bytes: 32, sha256: 'a'.repeat(64),
    truncated: false, mode: 0o600, uid: 1000, gid: 1000 };
  let requests = 0;
  const model = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'discover', name: 'tool_search', arguments: { query: 'read_remote_file', limit: 1 } }] };
    if (requests === 2 || requests === 3) return { calls: [{ id: `read-${requests}`, name: 'read_remote_file', arguments: { hostId: host.id, path: target } }] };
    return { text: '按新的保护规则拒绝读取，不展示文件。' };
  });
  try {
    const task = f.task('检查配置');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { timeout: 15000 });
    await f.server.dispatch({ method: 'update-host-safety', hostId: host.id, mode: 'ask',
      protectedReadPaths: [target], protectedWritePaths: [], revision: 2 });
    f.state.updateHost(host.id, { protectedReadPaths: [target], protectedWritePaths: [], protectedPaths: [target], policyRevision: 2 });
    release(snapshot);
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]); expect(requests).toBe(4);
    expect(JSON.stringify(model.requests)).not.toContain(snapshot.content);
    const first = model.requests[2]!.messages.find((message) => message.tool_call_id === 'read-2');
    const second = model.requests[3]!.messages.find((message) => message.tool_call_id === 'read-3');
    expect(fixtureMessageText(first!)).toContain('策略已变化');
    expect(fixtureMessageText(second!)).toContain('Protected path');
    expect(read).toHaveBeenCalledOnce();
    const records = f.store.list<OperationView>('operations').filter((op) => op.kind === 'read-file');
    expect(records).toHaveLength(2);
    expect(records.some((op) => op.readAudit!.events.at(-1)?.code === 'policy-changed')).toBe(true);
    expect(records.some((op) => op.readAudit!.policyRevision === 2 && op.readAudit!.events.at(-1)?.code === 'protected-resource')).toBe(true);
    expect(f.state.getHost(host.id).protectedReadPaths).toEqual([target]);
  } finally {
    release?.(snapshot);
    await model.close(); await f.close();
  }
});
