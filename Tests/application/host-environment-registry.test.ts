import { expect, it, vi } from 'vitest';
import { HostEnvironmentRegistry } from '@cloudhelm/application';
import type { HostEnvironmentData } from '@cloudhelm/core';
const data: HostEnvironmentData = { os: 'Linux', distribution: 'debian', version: '12', architecture: 'aarch64',
  architectureFamily: 'aarch64', kernel: '6.1',
  username: 'fixture', uid: 1000, loginDirectory: '/home/fixture',
  path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', toolPresence: { python3: true }, source: 'python' };
it('does not probe or connect for snapshots, disconnected hosts or recovery', async () => {
  const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => null, read });
  expect(registry.snapshot('host', 'fixture')).toMatchObject({ status: 'unknown', connectionId: null, observedAt: null });
  expect(await registry.refresh('host', 'fixture')).toMatchObject({ status: 'unknown' });
  expect(read).not.toHaveBeenCalled();
});
it('coalesces concurrent reads, bounds refresh frequency and returns detached values', async () => {
  let now = 1; const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  const [first, second] = await Promise.all([registry.refresh('host', 'fixture'), registry.refresh('host', 'fixture')]);
  expect(first).toEqual(second); expect(read).toHaveBeenCalledOnce();
  first.data!.toolPresence.python3 = false; expect(registry.snapshot('host', 'fixture').data?.toolPresence.python3).toBe(true);
  await registry.refresh('host', 'fixture'); expect(read).toHaveBeenCalledOnce();
  now += 5000; await registry.refresh('host', 'fixture'); expect(read).toHaveBeenCalledTimes(2);
});
it('never relabels a late old-connection observation as a new generation', async () => {
  let connectionId: string | null = 'worker:1', complete!: (data: HostEnvironmentData) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; })).mockResolvedValue({ ...data, os: 'New OS' });
  const registry = new HostEnvironmentRegistry({ connectionId: () => connectionId, read }, () => 10);
  const old = registry.refresh('host', 'fixture');
  connectionId = 'worker:2';
  expect(registry.snapshot('host', 'fixture')).toMatchObject({ status: 'unknown', connectionId: 'worker:2' });
  await registry.refresh('host', 'fixture'); complete(data);
  expect(await old).toMatchObject({ status: 'unknown', reason: 'connection-changed' });
  expect(registry.snapshot('host', 'fixture').data?.os).toBe('New OS');
  connectionId = null; expect(registry.snapshot('host', 'fixture').data).toBeUndefined();
  connectionId = 'new-worker:1'; expect(registry.snapshot('host', 'fixture').data).toBeUndefined();
});
it('isolates login identities and converts probe errors into unknown without leaking stderr', async () => {
  const read = vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('password=private-error'));
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => 20);
  await registry.refresh('host', 'fixture');
  expect(registry.snapshot('host', 'root').data).toBeUndefined();
  const unknown = await registry.refresh('host', 'root');
  expect(unknown).toMatchObject({ status: 'unknown', reason: 'unavailable' });
  expect(JSON.stringify(unknown)).not.toContain('private-error');
});
it('does not cache a cancelled read or turn cancellation into an observed success', async () => {
  const controller = new AbortController(); let finish!: (value: HostEnvironmentData) => void;
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1',
    read: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = registry.refresh('host', 'fixture', controller.signal);
  const failed = expect(pending).rejects.toThrow(); controller.abort(); finish(data); await failed;
  expect(registry.snapshot('host', 'fixture').status).toBe('unknown');
});

it('reports SSH, metadata and exec-channel readiness as separate facts', async () => {
  const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => 30);
  // Before any probe: the SSH session exists, but nothing is known about the host.
  expect(registry.snapshot('host', 'fixture').readiness)
    .toEqual({ ssh: 'connected', metadata: 'unknown', execution: 'unknown' });
  expect((await registry.refresh('host', 'fixture')).readiness)
    .toEqual({ ssh: 'connected', metadata: 'ready', execution: 'ready' });
  const shell = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read: async () => ({ ...data, source: 'shell' }) }, () => 31);
  expect((await shell.refresh('host', 'fixture')).readiness)
    .toEqual({ ssh: 'connected', metadata: 'degraded', execution: 'ready' });
  expect(new HostEnvironmentRegistry({ connectionId: () => null, read }).snapshot('host', 'fixture').readiness)
    .toEqual({ ssh: 'disconnected', metadata: 'unknown', execution: 'unknown' });
});

it('keeps a bounded cause instead of one undifferentiated probe failure', async () => {
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1',
    read: async () => { throw Object.assign(new Error('Host metadata unavailable'), { reason: 'python-missing' }); } }, () => 40);
  const observation = await registry.refresh('host', 'fixture');
  expect(observation).toMatchObject({ status: 'unknown', reason: 'python-missing' });
  expect(JSON.stringify(observation)).not.toContain('Host metadata unavailable');
  const unrelated = new HostEnvironmentRegistry({ connectionId: () => 'worker:1',
    read: async () => { throw Object.assign(new Error('private-detail'), { reason: 'not-a-real-reason' }); } }, () => 41);
  expect(await unrelated.refresh('host', 'fixture')).toMatchObject({ reason: 'unavailable' });
});

it('backfills command-observed readiness and keeps it across re-probes', async () => {
  let now = 100; const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  await registry.refresh('host', 'fixture');
  registry.absorbCommandFacts('host', 'fixture', { readiness: [{ tool: 'docker', state: 'responsive',
    observedAs: 'fixture', observedAt: now, evidence: 'exit-0' }], staleReadiness: [], presenceStale: false });
  expect(registry.snapshot('host', 'fixture').toolReadiness)
    .toEqual([{ tool: 'docker', state: 'responsive', observedAs: 'fixture', observedAt: 100, evidence: 'exit-0' }]);
  now += 10_000;
  expect((await registry.refresh('host', 'fixture')).toolReadiness).toHaveLength(1);
  expect(registry.snapshot('host', 'fixture').toolReadiness).toHaveLength(1);
  expect(registry.snapshot('host', 'fixture').presenceStale).toBeUndefined();
});

it('drops first and backfills second so a stop cannot keep stale daemon readiness', async () => {
  const now = 200; const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  await registry.refresh('host', 'fixture');
  registry.absorbCommandFacts('host', 'fixture', { readiness: [{ tool: 'docker', state: 'responsive',
    observedAs: 'fixture', observedAt: now, evidence: 'exit-0' }], staleReadiness: [], presenceStale: false });
  registry.absorbCommandFacts('host', 'fixture', { readiness: [{ tool: 'systemctl', state: 'responsive',
    observedAs: 'root', observedAt: now, evidence: 'exit-0' }], staleReadiness: ['docker', 'systemctl'], presenceStale: true });
  expect(registry.snapshot('host', 'fixture').toolReadiness)
    .toEqual([{ tool: 'systemctl', state: 'responsive', observedAs: 'root', observedAt: 200, evidence: 'exit-0' }]);
  expect(registry.snapshot('host', 'fixture').presenceStale).toBe(true);
});

it('re-probes presence after a mutation instead of serving the deduped cache', async () => {
  const now = 300; const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  await registry.refresh('host', 'fixture');
  registry.absorbCommandFacts('host', 'fixture', { readiness: [], staleReadiness: [], presenceStale: true });
  expect(registry.snapshot('host', 'fixture').presenceStale).toBe(true);
  await registry.refresh('host', 'fixture');
  expect(read).toHaveBeenCalledTimes(2);
  expect(registry.snapshot('host', 'fixture').presenceStale).toBeUndefined();
});

it('keeps the invalidation when a mutation lands during an in-flight probe', async () => {
  let now = 400, release!: (value: HostEnvironmentData) => void;
  const read = vi.fn(async () => data)
    .mockImplementationOnce(async () => data)
    .mockImplementationOnce(() => new Promise<HostEnvironmentData>((resolve) => { release = resolve; }));
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  await registry.refresh('host', 'fixture');
  now += 5000;
  const pending = registry.refresh('host', 'fixture');
  registry.absorbCommandFacts('host', 'fixture', { readiness: [], staleReadiness: [], presenceStale: true });
  release(data);
  await pending;
  expect(registry.snapshot('host', 'fixture').presenceStale).toBe(true);
  await registry.refresh('host', 'fixture');
  expect(read).toHaveBeenCalledTimes(3);
  expect(registry.snapshot('host', 'fixture').presenceStale).toBeUndefined();
});

it('drops facts without a matching record, identity or connection and never probes for them', async () => {
  const now = 500; const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => 'worker:1', read }, () => now);
  registry.absorbCommandFacts('host', 'fixture', { readiness: [{ tool: 'docker', state: 'responsive',
    observedAs: 'fixture', observedAt: now, evidence: 'exit-0' }], staleReadiness: [], presenceStale: true });
  await registry.refresh('host', 'fixture');
  expect(registry.snapshot('host', 'fixture').toolReadiness).toBeUndefined();
  expect(registry.snapshot('host', 'fixture').presenceStale).toBeUndefined();
  registry.absorbCommandFacts('host', 'root', { readiness: [{ tool: 'docker', state: 'responsive',
    observedAs: 'root', observedAt: now, evidence: 'exit-0' }], staleReadiness: [], presenceStale: true });
  expect(registry.snapshot('host', 'fixture').toolReadiness).toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
});

it('never serves readiness facts from an earlier connection', async () => {
  let connectionId: string | null = 'worker:1';
  const read = vi.fn(async () => data);
  const registry = new HostEnvironmentRegistry({ connectionId: () => connectionId, read }, () => 600);
  await registry.refresh('host', 'fixture');
  registry.absorbCommandFacts('host', 'fixture', { readiness: [{ tool: 'docker', state: 'responsive',
    observedAs: 'fixture', observedAt: 600, evidence: 'exit-0' }], staleReadiness: [], presenceStale: false });
  expect(registry.snapshot('host', 'fixture').toolReadiness).toHaveLength(1);
  connectionId = 'worker:2';
  expect(registry.snapshot('host', 'fixture').status).toBe('unknown');
  await registry.refresh('host', 'fixture');
  expect(registry.snapshot('host', 'fixture').toolReadiness).toBeUndefined();
});
