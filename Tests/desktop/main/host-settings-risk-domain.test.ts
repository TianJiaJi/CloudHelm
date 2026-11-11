import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, SqliteStore } from '@cloudhelm/adapters';
import { PermissionAwareExecutor, type HostSerialExecutor } from '@cloudhelm/application';
import type { HostDraft, HostView } from '@cloudhelm/contracts';
import type { ProposedOperation } from '@cloudhelm/core';
import { createHostSettings, editHostSettings } from '../../../apps/desktop/src/main/host-settings.js';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';

const stores: SqliteStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
const draft: HostDraft = { label: 'Synthetic risk target', address: 'host.invalid', port: 22, username: 'user', auth: 'password' };

function fixture() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  const context = { store, hosts: new Map<string, HostView>(), encrypt: () => 'synthetic-sealed-empty-credentials',
    secret: () => undefined, publish: vi.fn() };
  const original = createHostSettings(context, draft);
  // No sockets, environment probe, model or real remote executor. Keep the actual
  // Worker registration, restore dispatch and HostSerialExecutor write-lock logic.
  vi.spyOn(SshTransport.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(SshTransport.prototype, 'connectionId').mockReturnValue(null);
  const environment = vi.spyOn(SshTransport.prototype, 'readEnvironment').mockRejectedValue(new Error('Network forbidden in this fixture'));
  const downstream = vi.spyOn(PermissionAwareExecutor.prototype, 'execute').mockImplementation(async (operation) => ({
    operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: 'synthetic executor result'
  }));
  const server = new WorkerServer(() => undefined);
  const serial = (server as unknown as { executor: HostSerialExecutor }).executor;
  return { context, original, server, serial, downstream, environment };
}
function write(host: HostView): ProposedOperation {
  return { id: 'new-write', kind: 'write-file', path: '/tmp/synthetic-target', content: 'synthetic', scope: {
    taskId: 'new-task', hostId: host.id, cwd: '/tmp', runAs: host.username, terminalId: 'synthetic-terminal', terminalGeneration: 1,
    policyRevision: host.policyRevision, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'Synthetic lock regression'
  } };
}

describe('host settings revisions retain unresolved remote risk', () => {
  it('blocks the original host while allowing an explicit diagnostic read', async () => {
    const f = fixture();
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: f.original });
    expect(await f.serial.execute(write(f.original), 'synthetic-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled();
    const query: ProposedOperation = { id: 'diagnostic', kind: 'command', command: 'pwd', scope: write(f.original).scope };
    expect((await f.serial.execute(query, 'diagnostic-fingerprint', undefined, { readOnly: true })).status).toBe('succeeded');
    expect(f.downstream).toHaveBeenCalledOnce(); expect(f.environment).not.toHaveBeenCalled();
  });
  it('does not allow host drafts to forge a risk domain or predecessor', async () => {
    const f = fixture();
    const untrusted = { ...draft, username: 'new-login', riskDomainId: 'forged-free-domain', previousHostId: 'forged-parent' };
    const added = createHostSettings(f.context, untrusted);
    expect(added).not.toHaveProperty('riskDomainId'); expect(added).not.toHaveProperty('previousHostId');
    const replacement = editHostSettings(f.context, f.original.id, untrusted);
    expect(replacement).not.toHaveProperty('riskDomainId'); expect(replacement.previousHostId).toBe(f.original.id);
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: replacement });
    expect(await f.serial.execute(write(replacement), 'synthetic-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled(); expect(f.environment).not.toHaveBeenCalled();
  });
  it.each([
    ['timeout-only', { connection: { version: 1 as const, timeoutMs: 4000 } }],
    ['login-only', { username: 'another-login' }],
    ['destination', { address: 'different.invalid' }],
    ['proxy-route', { connection: { version: 1 as const, proxy: { enabled: true, protocol: 'socks5' as const, address: 'proxy.invalid', port: 8080 } } }]
  ] as const)('cannot bypass a restored unknown write through a %s revision', async (_name, change) => {
    const f = fixture();
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: f.original });
    const replacement = editHostSettings(f.context, f.original.id, { ...draft, ...change });
    expect(replacement.id).not.toBe(f.original.id); // Keep connection/credential recipient identities separate.
    expect(replacement.previousHostId).toBe(f.original.id);
    await f.server.dispatch({ method: 'connect', host: replacement });
    expect(await f.serial.execute(write(replacement), 'synthetic-new-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled(); expect(f.environment).not.toHaveBeenCalled();
  });
});
