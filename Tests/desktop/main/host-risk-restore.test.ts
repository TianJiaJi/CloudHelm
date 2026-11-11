import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteStore, SshTransport } from '@cloudhelm/adapters';
import { PermissionAwareExecutor, type HostSerialExecutor } from '@cloudhelm/application';
import type { HostView, OperationView } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';

const native = vi.hoisted(() => ({ isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn(() => { throw new Error('Credential access forbidden'); }),
  decryptString: vi.fn(() => { throw new Error('Credential access forbidden'); }) }));
vi.mock('electron', () => ({ safeStorage: native }));
const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const base: HostView = { id: 'original', label: 'Synthetic', address: 'host.invalid', port: 22, username: 'user', auth: 'password',
  status: 'disconnected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };

it('restores all archived revision bindings before connecting only the newest host, without decrypting credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-risk-restore-')); resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'records.sqlite');
  const seed = new SqliteStore(file);
  try {
    seed.put('hosts', base.id, { ...base, archived: true });
    seed.put('hosts', 'middle', { ...base, id: 'middle', previousHostId: base.id, archived: true });
    seed.put('hosts', 'latest', { ...base, id: 'latest', previousHostId: 'middle', username: 'other-login' });
    seed.put('secrets', 'host-credentials:middle', 'synthetic-undecipherable-record');
    seed.put('operations', 'unknown-operation', { id: 'unknown-operation', taskId: 'prior-task', hostId: 'middle', kind: 'command',
      status: 'unknown', preview: 'synthetic change', createdAt: 1 } satisfies OperationView);
  } finally { seed.close(); }
  const store = new SqliteStore(file); resources.push(() => store.close());
  const state = new AppState(store, () => undefined); resources.push(() => state.close());
  const bindings = state.hostRiskBindings();
  expect(state.snapshot().hostRiskBindings).toEqual(bindings);
  expect(bindings).toEqual(expect.arrayContaining(['original', 'middle', 'latest'].map((hostId) => ({ hostId, riskDomainId: 'original' }))));
  const host = state.runtimeHost('latest'); expect(host).toMatchObject({ id: 'latest', username: 'other-login', riskDomainId: 'original' });
  expect(native.decryptString).not.toHaveBeenCalled(); expect(native.encryptString).not.toHaveBeenCalled();
  const connect = vi.spyOn(SshTransport.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(SshTransport.prototype, 'connectionId').mockReturnValue(null);
  const downstream = vi.spyOn(PermissionAwareExecutor.prototype, 'execute').mockResolvedValue({ operationId: 'new', status: 'succeeded', stdoutTail: '' });
  const worker = new WorkerServer(() => undefined);
  await worker.dispatch({ method: 'restore-operations', riskBindings: bindings,
    operations: state.snapshot().operations.map(({ id, hostId }) => ({ id, hostId })) });
  await worker.dispatch({ method: 'connect', host });
  const serial = (worker as unknown as { executor: HostSerialExecutor }).executor;
  expect(await serial.execute({ id: 'new', kind: 'write-file', path: '/tmp/synthetic', content: 'synthetic', scope: {
    taskId: 'task', hostId: host.id, cwd: '/tmp', runAs: host.username, terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'Synthetic restored lock'
  } }, 'synthetic-fingerprint')).toMatchObject({ status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation' });
  expect(downstream).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledOnce();
  expect(connect.mock.calls[0]![0].id).toBe('latest');
});
