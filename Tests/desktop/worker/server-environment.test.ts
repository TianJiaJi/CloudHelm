import { afterEach, expect, it, vi } from 'vitest';
import { SshTransport } from '@cloudhelm/adapters';
import type { HostEnvironmentData } from '@cloudhelm/core';
import type { RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';
const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'fixture', auth: 'password',
  status: 'disconnected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const data: HostEnvironmentData = { os: 'Linux', distribution: 'debian', version: '12', kernel: '6', architecture: 'x86_64',
  uid: 1000, username: 'fixture', directory: '/home/fixture', tools: {}, source: 'python' };
afterEach(() => vi.restoreAllMocks());
it('collects login metadata after a successful explicit connection, never before authentication', async () => {
  let connected = false;
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async () => { connected = true; });
  vi.spyOn(SshTransport.prototype, 'connectionId').mockImplementation(() => connected ? 'worker:1' : null);
  const read = vi.spyOn(SshTransport.prototype, 'readEnvironment').mockImplementation(async (hostId, loginAs, signal) => {
    expect(connected).toBe(true); expect(hostId).toBe('host'); expect(loginAs).toBe('fixture'); expect(signal?.aborted).toBe(false);
    return data;
  });
  const messages: RuntimeMessage[] = [], server = new WorkerServer((event) => messages.push(event));
  expect(read).not.toHaveBeenCalled();
  await server.dispatch({ method: 'connect', host });
  expect(read).toHaveBeenCalledOnce();
  expect(messages).toContainEqual({ event: { type: 'host-status', hostId: 'host', status: 'connected' } });
});
it('does not fail a valid SSH connection or publish private probe errors when metadata is unavailable', async () => {
  vi.spyOn(SshTransport.prototype, 'connect').mockResolvedValue();
  vi.spyOn(SshTransport.prototype, 'connectionId').mockReturnValue('worker:1');
  vi.spyOn(SshTransport.prototype, 'readEnvironment').mockRejectedValue(new Error('password=private-probe-stderr'));
  const messages: RuntimeMessage[] = [], server = new WorkerServer((event) => messages.push(event));
  await server.dispatch({ method: 'connect', host });
  expect(messages).toContainEqual({ event: { type: 'host-status', hostId: 'host', status: 'connected' } });
  expect(JSON.stringify(messages)).not.toContain('private-probe-stderr');
});
it('disconnect cancels an in-flight observation and its late result cannot restore connected status', async () => {
  let connected = false, finish!: (data: HostEnvironmentData) => void, enter!: () => void, probeSignal: AbortSignal | undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async () => { connected = true; });
  vi.spyOn(SshTransport.prototype, 'disconnect').mockImplementation(() => { connected = false; });
  vi.spyOn(SshTransport.prototype, 'connectionId').mockImplementation(() => connected ? 'worker:1' : null);
  vi.spyOn(SshTransport.prototype, 'readEnvironment').mockImplementation(async (_id, _login, signal) => {
    probeSignal = signal; return new Promise((resolve) => { finish = resolve; enter(); });
  });
  const messages: RuntimeMessage[] = [], server = new WorkerServer((event) => messages.push(event));
  const pending = server.dispatch({ method: 'connect', host });
  const cancelled = expect(pending).rejects.toThrow('SSH 连接已取消');
  await entered; await server.dispatch({ method: 'disconnect', hostId: 'host' });
  expect(probeSignal?.aborted).toBe(true); finish(data); await cancelled;
  expect(messages).not.toContainEqual({ event: { type: 'host-status', hostId: 'host', status: 'connected' } });
});
