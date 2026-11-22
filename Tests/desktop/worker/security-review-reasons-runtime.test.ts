import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport, SshCommandTerminal } from '@cloudhelm/adapters';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { securityWorker } from './security-worker-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());

it('shows the exact uncertainty in a real approval and retains it after rejection in SQLite', async () => {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
  vi.spyOn(SshTransport.prototype, 'matchesConnection').mockReturnValue(true);
  vi.spyOn(SshTransport.prototype, 'execFixed').mockResolvedValue({ exitCode: 0, output: '/srv/app\n' });
  const dispatch = vi.spyOn(SshCommandTerminal.prototype, 'execute').mockResolvedValue();
  const f = await securityWorker(host);
  const model = await openAiFixture(async (request) => request.messages.some((message) => message.role === 'tool')
    ? { text: '用户拒绝，未执行。' }
    : { calls: [{ id: 'uncertain', name: 'run_remote', arguments: { hostId: host.id, command: 'ss -K' } }] });
  try {
    const task = f.task('检查网络状态');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    // The production fixture rejects approval through the actual Worker IPC handler.
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]); expect(dispatch).not.toHaveBeenCalled();
    const approval = f.messages.find((message) => 'event' in message && message.event.type === 'approval-open');
    expect(approval && 'event' in approval && approval.event.type === 'approval-open' && approval.event.value.explanation)
      .toContain('[unsupported-query-form]');
    const disk = new SqliteStore(f.file);
    try {
      const records = disk.list<OperationView>('operations');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ taskId: task.id, status: 'denied', ruleId: 'human-denied' });
      expect(records[0]!.reason).toContain('[uncertain-command]');
      expect(records[0]!.reason).toContain('[unsupported-query-form]');
    } finally { disk.close(); }
  } finally { await model.close(); await f.close(); }
});
