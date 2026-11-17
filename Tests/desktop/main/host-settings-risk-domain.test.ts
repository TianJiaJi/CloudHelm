import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshTransport, SqliteStore } from '@cloudhelm/adapters';
import { PermissionAwareExecutor, type HostSerialExecutor } from '@cloudhelm/application';
import type { HostDraft, HostView } from '@cloudhelm/contracts';
import { resolveHostRiskBindings, type ProposedOperation } from '@cloudhelm/core';
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
  it('does not allow host drafts to forge a risk domain, predecessor or association', async () => {
    const f = fixture();
    const untrusted = { ...draft, username: 'new-login', riskDomainId: 'forged-free-domain', previousHostId: 'forged-parent', riskPeerHostId: 'forged-peer' };
    const added = createHostSettings(f.context, untrusted);
    expect(added).not.toHaveProperty('riskDomainId'); expect(added).not.toHaveProperty('previousHostId');
    expect(added).not.toHaveProperty('riskPeerHostId');
    const replacement = editHostSettings(f.context, f.original.id, untrusted);
    expect(replacement).not.toHaveProperty('riskDomainId'); expect(replacement.previousHostId).toBe(f.original.id);
    expect(replacement.riskPeerHostId).toBeUndefined();
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

describe('duplicate target configurations share the unresolved risk domain', () => {
  it('blocks a duplicate configuration write behind the original record lock', async () => {
    const f = fixture();
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: f.original });
    const duplicate = createHostSettings(f.context, draft);
    expect(duplicate.riskPeerHostId).toBe(f.original.id);
    await f.server.dispatch({ method: 'connect', host: duplicate, riskBindings: resolveHostRiskBindings(f.context.hosts) });
    expect(await f.serial.execute(write(duplicate), 'synthetic-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled(); expect(f.environment).not.toHaveBeenCalled();
  });
  it('keeps a target-unchanged revision inside the associated domain', async () => {
    const f = fixture();
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: f.original });
    const duplicate = createHostSettings(f.context, draft);
    const revision = editHostSettings(f.context, duplicate.id,
      { ...draft, connection: { version: 1 as const, timeoutMs: 4000 } });
    expect(revision.previousHostId).toBe(duplicate.id);
    expect(revision.riskPeerHostId).toBeUndefined();
    await f.server.dispatch({ method: 'connect', host: revision, riskBindings: resolveHostRiskBindings(f.context.hosts) });
    expect(await f.serial.execute(write(revision), 'synthetic-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled(); expect(f.environment).not.toHaveBeenCalled();
  });
  it('does not inherit the association when the target changes', () => {
    const f = fixture();
    const duplicate = createHostSettings(f.context, draft);
    const moved = editHostSettings(f.context, duplicate.id, { ...draft, address: 'fresh.invalid' });
    expect(moved.riskPeerHostId).toBeUndefined();
  });
  it('does not re-associate a changed target even when another duplicate exists there', async () => {
    const f = fixture();
    await f.server.dispatch({ method: 'restore-operations', operations: [{ id: 'prior-unknown', hostId: f.original.id }] });
    await f.server.dispatch({ method: 'connect', host: f.original });
    createHostSettings(f.context, { ...draft, address: 'fresh.invalid' });
    const moved = editHostSettings(f.context, f.original.id, { ...draft, address: 'fresh.invalid' });
    expect(moved.riskPeerHostId).toBeUndefined();
    expect(moved.previousHostId).toBe(f.original.id);
    await f.server.dispatch({ method: 'connect', host: moved, riskBindings: resolveHostRiskBindings(f.context.hosts) });
    expect(await f.serial.execute(write(moved), 'synthetic-fingerprint')).toMatchObject({
      status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation'
    });
    expect(f.downstream).not.toHaveBeenCalled(); expect(f.environment).not.toHaveBeenCalled();
  });
});
