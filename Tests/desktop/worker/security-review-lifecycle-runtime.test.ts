import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport, SshCommandTerminal } from '@cloudhelm/adapters';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { securityWorker } from './security-worker-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());

it('invalidates a pending approval on policy change and never dispatches a late approval', async () => {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
  vi.spyOn(SshTransport.prototype, 'matchesConnection').mockReturnValue(true);
  vi.spyOn(SshTransport.prototype, 'execFixed').mockResolvedValue({ exitCode: 0, output: '/srv/app\n' });
  const dispatch = vi.spyOn(SshCommandTerminal.prototype, 'execute').mockResolvedValue();
  const f = await securityWorker(host, { autoRejectApproval: false });
  let requests = 0;
  const model = await openAiFixture(async () => ++requests === 1
    ? { calls: [{ id: 'pending', name: 'run_remote', arguments: { hostId: host.id, command: 'customctl inspect' } }] }
    : { text: '原审批失效，不重试。' });
  try {
    const task = f.task('检查状态');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(f.state.snapshot().approvals).toHaveLength(1), { timeout: 15000 });
    const approvalId = f.state.snapshot().approvals[0]!.id;
    f.state.updateHost(host.id, { policyRevision: 2 });
    await f.server.dispatch({ method: 'update-host-safety', hostId: host.id, mode: 'ask', revision: 2,
      protectedReadPaths: [], protectedWritePaths: [] });
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    await expect(f.server.dispatch({ method: 'decide-approval', approvalId, approved: true })).rejects.toThrow('Approval expired');
    expect(f.state.snapshot().approvals).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled(); expect(model.errors).toEqual([]); expect(requests).toBe(2);
    const disk = new SqliteStore(f.file);
    try {
      const records = disk.list<OperationView>('operations');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ taskId: task.id, status: 'denied', ruleId: 'authorization-expired' });
      expect(records[0]!.reason).toContain('[unrecognized-operation]');
    } finally { disk.close(); }
  } finally { await model.close(); await f.close(); }
});
