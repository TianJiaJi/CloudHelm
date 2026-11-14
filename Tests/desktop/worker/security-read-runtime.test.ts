import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport } from '@cloudhelm/adapters';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { OperationView } from '@cloudhelm/contracts';
import { securityWorker } from './security-worker-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());
const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };

it.each(['/srv/app/.env', '/srv/app/config.yaml', '/srv/app/plain.txt'])('persists read refusal/redaction through the actual WorkerServer (%s)', async (target) => {
  const f = await securityWorker(host);
  const plain = target.endsWith('plain.txt');
  const read = vi.spyOn(SshTransport.prototype, 'readFileForEdit').mockResolvedValue({ content: plain ? 'listen=8080\n' : 'password="synthetic-hidden"\n',
    sha256: 'a'.repeat(64), bytes: 28, truncated: false, mode: 0o600, uid: 1000, gid: 1000 });
  let requests = 0;
  const model = await openAiFixture(async () => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'discover', name: 'tool_search', arguments: { query: 'read_remote_file', limit: 1 } }] };
    if (requests === 2) return { calls: [{ id: 'read-sensitive', name: 'read_remote_file', arguments: { hostId: host.id, path: target } }] };
    return { text: '按后端返回说明结果，不泄露文件内容。' };
  });
  try {
    const task = f.task(`读取 ${target}`);
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]); expect(requests).toBe(3);
    const result = model.requests[2]!.messages.find((message) => message.tool_call_id === 'read-sensitive');
    expect(result).toBeDefined();
    if (target.endsWith('.env')) {
      expect(fixtureMessageText(result!)).toContain('Credential file');
      expect(read).not.toHaveBeenCalled();
    } else {
      expect(fixtureMessageText(result!)).toContain(plain ? 'listen=8080' : 'REDACTED');
      expect(read).toHaveBeenCalledOnce();
    }
    expect(JSON.stringify(model.requests)).not.toContain('synthetic-hidden');
    const reopened = new SqliteStore(f.file);
    try {
      const records = reopened.list<OperationView>('operations');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: 'read-file', taskId: task.id, readOnly: true, effects: 'none',
        status: target.endsWith('.env') ? 'denied' : 'succeeded' });
      expect(records[0]!.readAudit!.events.at(-1)).toMatchObject(target.endsWith('.env')
        ? { phase: 'denied', code: 'credential-resource' }
        : { phase: 'completed', redacted: !plain, truncated: false });
      expect(JSON.stringify(records)).not.toContain('synthetic-hidden');
      expect(records[0]?.outputTail).toBeUndefined();
    } finally { reopened.close(); }
    expect(f.messages.some((message) => 'commitOperation' in message)).toBe(true);
  } finally { await model.close(); await f.close(); }
});
