import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport, SshCommandTerminal } from '@cloudhelm/adapters';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { securityWorker } from './security-worker-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());

it.each(['ss -ltnp', 'df -h && free -m'])('runs proven query %s in cautious mode without human or AI review, with durable audit', async (command) => {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
  vi.spyOn(SshTransport.prototype, 'matchesConnection').mockReturnValue(true);
  vi.spyOn(SshTransport.prototype, 'execFixed').mockResolvedValue({ exitCode: 0, output: '/srv/app\n' });
  const exits = new Map<SshCommandTerminal, (code: number | undefined) => void>();
  vi.spyOn(SshCommandTerminal.prototype, 'onExit').mockImplementation(function (this: SshCommandTerminal, listener) { exits.set(this, listener); });
  let exit: (() => void) | undefined;
  const dispatch = vi.spyOn(SshCommandTerminal.prototype, 'execute').mockImplementation(async function (this: SshCommandTerminal, text, _cwd, authorized) {
    expect(text).toBe(command); expect(authorized()).toBe(true);
    // Inspect Main's durable journal at the transport boundary, not after execution.
    expect(f.store.list<OperationView>('operations')).toEqual([expect.objectContaining({
      readOnly: true, ruleId: 'low-risk-command' })]);
    exit = () => exits.get(this)!(0);
  });
  const f = await securityWorker(host);
  let requests = 0;
  const model = await openAiFixture(async () => ++requests === 1
    ? { calls: [{ id: 'query', name: 'run_remote', arguments: { hostId: host.id, command } }] }
    : { text: '仅总结观察结果。' });
  try {
    const task = f.task('检查系统运行状态');
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl });
    await vi.waitFor(() => expect(dispatch.mock.calls.length > 0 || f.state.getTask(task.id).status === 'answered').toBe(true), { timeout: 15000 });
    expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-open')).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.store.list<OperationView>('operations')).toEqual([expect.objectContaining({ taskId: task.id,
      readOnly: true, ruleId: 'low-risk-command' })]);
    exit!(); exit = undefined;
    await vi.waitFor(() => expect(f.state.getTask(task.id).status).toBe('answered'), { timeout: 15000 });
    expect(model.errors).toEqual([]); expect(requests).toBe(2);
    const disk = new SqliteStore(f.file);
    try {
      expect(disk.list<OperationView>('operations')).toEqual([expect.objectContaining({ taskId: task.id,
        status: 'succeeded', readOnly: true, effects: 'none', ruleId: 'low-risk-command' })]);
    } finally { disk.close(); }
  } finally { exit?.(); await model.close(); await f.close(); }
});
