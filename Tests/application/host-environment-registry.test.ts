import { expect, it, vi } from 'vitest';
import { HostEnvironmentRegistry } from '@cloudhelm/application';
import type { HostEnvironmentData } from '@cloudhelm/core';
const data: HostEnvironmentData = { os: 'Linux', distribution: 'debian', version: '12', architecture: 'aarch64', kernel: '6.1',
  username: 'fixture', uid: 1000, directory: '/home/fixture', tools: { python3: true } };
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
  first.data!.tools.python3 = false; expect(registry.snapshot('host', 'fixture').data?.tools.python3).toBe(true);
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
