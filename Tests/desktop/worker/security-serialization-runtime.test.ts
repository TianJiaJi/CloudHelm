import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport, SshCommandTerminal } from '@cloudhelm/adapters';
import { HostSerialExecutor } from '@cloudhelm/application';
import { operationNeedsVerification, type OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { securityWorker } from './security-worker-fixture.js';
import { openAiFixture } from './openai-sse-fixture.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
afterEach(() => vi.restoreAllMocks());
const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', protectedPaths: [], defaultMode: 'permissive', policyRevision: 1 };

it('shares a real worker lock across two Pi sessions and restores the durable unresolved lock in a new WorkerServer', async () => {
  vi.spyOn(SshTransport.prototype, 'matchesConnection').mockReturnValue(true);
  vi.spyOn(SshTransport.prototype, 'execFixed').mockResolvedValue({ exitCode: 0, output: '/srv/app\n' });
  const exits = new Map<SshCommandTerminal, (code: number | undefined) => void>();
  vi.spyOn(SshCommandTerminal.prototype, 'onExit').mockImplementation(function (this: SshCommandTerminal, listener) { exits.set(this, listener); });
  const dispatched: Array<{ command: string; exit(code?: number): void }> = [];
  vi.spyOn(SshCommandTerminal.prototype, 'execute').mockImplementation(async function (this: SshCommandTerminal, command, _cwd, authorized) {
    expect(authorized()).toBe(true);
    dispatched.push({ command, exit: (code) => exits.get(this)!(code) });
  });
  const entries: Array<{ executor: HostSerialExecutor; command: string }> = [];
  const realExecute = HostSerialExecutor.prototype.execute;
  // Observe actual entry into the real method; do not replace its queue/lock behavior.
  vi.spyOn(HostSerialExecutor.prototype, 'execute').mockImplementation(function (this: HostSerialExecutor, ...args) {
    entries.push({ executor: this, command: args[0].kind === 'command' ? args[0].command : args[0].kind });
    return realExecute.apply(this, args);
  });
  const f = await securityWorker(host);
  const models: Array<Awaited<ReturnType<typeof openAiFixture>>> = [];
  async function start(command: string, worker = f.server) {
    let requests = 0;
    const model = await openAiFixture(async () => ++requests === 1
      ? { calls: [{ id: 'run', name: 'run_remote', arguments: { hostId: host.id, command } }] }
      : { text: '只说明后端实际结果，不重放。' });
    models.push(model);
    const task = f.task(command);
    await f.start(task, { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only', baseUrl: model.baseUrl }, worker);
    return task;
  }
  const operations = () => f.store.list<OperationView>('operations');
  try {
    const a = await start('touch /tmp/security-a');
    await vi.waitFor(() => expect(dispatched).toHaveLength(1), { timeout: 15000 });
    const b = await start('touch /tmp/security-b');
    await vi.waitFor(() => expect(entries).toHaveLength(2), { timeout: 15000 });
    expect(entries[0]!.executor).toBe(entries[1]!.executor);
    expect(dispatched.map((item) => item.command)).toEqual(['touch /tmp/security-a']);
    expect(operations().some((op) => op.taskId === b.id && op.status === 'running')).toBe(true);
    dispatched[0]!.exit(0);
    await vi.waitFor(() => expect(dispatched).toHaveLength(2), { timeout: 15000 });
    expect(dispatched[1]!.command).toBe('touch /tmp/security-b');
    dispatched[1]!.exit(0);
    await vi.waitFor(() => expect([a, b].every((task) => f.state.getTask(task.id).status === 'answered')).toBe(true), { timeout: 15000 });

    const lost = await start('touch /tmp/security-unknown');
    await vi.waitFor(() => expect(dispatched).toHaveLength(3), { timeout: 15000 });
    dispatched[2]!.exit(undefined); // Actual TerminalManager observation: no exit code.
    await vi.waitFor(() => expect(operations().find((op) => op.taskId === lost.id)?.status).toBe('unknown'), { timeout: 15000 });
    f.state.runtimeStopped();

    // Reopen the same SQLite and use production Main recovery + startup ordering.
    const disk = new SqliteStore(f.file);
    const recovered = new AppState(disk, () => {});
    const freshWorker = f.createWorker();
    try {
      const unresolved = recovered.snapshot().operations.filter(operationNeedsVerification);
      expect(unresolved).toHaveLength(1);
      await freshWorker.dispatch({ method: 'restore-operations', riskBindings: recovered.hostRiskBindings(),
        operations: unresolved.map(({ id, hostId }) => ({ id, hostId })) });
    } finally { recovered.close(); disk.close(); }
    const blocked = await start('touch /tmp/security-after-restart', freshWorker);
    await vi.waitFor(() => expect(operations().find((op) => op.taskId === blocked.id)?.failureKind)
      .toBe('unresolved-prior-operation'), { timeout: 15000 });
    expect(entries.at(-1)!.executor).not.toBe(entries[0]!.executor);
    expect(dispatched).toHaveLength(3); // No changed command reaches the transport.
    const query = await start('df -h', freshWorker);
    await vi.waitFor(() => expect(dispatched).toHaveLength(4), { timeout: 15000 });
    expect(dispatched[3]!.command).toBe('df -h');
    dispatched[3]!.exit(0);
    await vi.waitFor(() => expect(operations().find((op) => op.taskId === query.id))
      .toMatchObject({ status: 'succeeded', readOnly: true }), { timeout: 15000 });
    expect(models.flatMap((model) => model.errors)).toEqual([]);
  } finally {
    for (const item of dispatched) item.exit(0);
    for (const model of models) await model.close();
    await f.close();
  }
}, 30000);
