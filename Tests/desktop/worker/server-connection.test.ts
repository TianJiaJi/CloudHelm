import { afterEach, expect, it, vi } from 'vitest';
import { SshTransport } from '@cloudhelm/adapters';
import type { RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';

const host: RuntimeHost = { id: 'fixture', label: 'fixture', address: '127.0.0.1', port: 22, username: 'fixture', auth: 'password',
  status: 'disconnected', protectedPaths: [], defaultMode: 'ai-review', policyRevision: 1 };
const prompt = { hostId: host.id, username: host.username, text: 'Password:', echo: false };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('cancels a pending login, closes its private input and refuses a late answer', async () => {
  vi.useFakeTimers(); const events: RuntimeMessage[] = [], server = new WorkerServer((message) => events.push(message));
  let seenSignal: AbortSignal | undefined;
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async (_host, _material, _jump, ask, signal) => {
    seenSignal = signal; expect(await ask!(prompt)).toBeNull(); signal!.throwIfAborted();
  });
  const connecting = server.dispatch({ method: 'connect', host });
  const input = events.find((event) => 'event' in event && event.event.type === 'input-open');
  if (!input || !('event' in input) || input.event.type !== 'input-open') throw new Error('Missing private login');
  expect(input.event.value.operationId).toMatch(/^ssh-login:/u);
  const rejected = expect(connecting).rejects.toThrow('SSH 连接已取消');
  await server.dispatch({ method: 'disconnect', hostId: host.id }); await rejected;
  expect(seenSignal?.aborted).toBe(true);
  expect(events).toContainEqual({ event: { type: 'input-close', id: input.event.value.id } });
  expect(events).not.toContainEqual({ event: { type: 'host-status', hostId: host.id, status: 'connected' } });
  await expect(server.dispatch({ method: 'answer-input', requestId: input.event.value.id, answer: 'late-private-answer' })).rejects.toThrow();
  expect(JSON.stringify(events)).not.toContain('late-private-answer'); expect(vi.getTimerCount()).toBe(0);
});
it('refuses an expired private answer even before its timer callback has run', async () => {
  vi.useFakeTimers(); const events: RuntimeMessage[] = [], server = new WorkerServer((message) => events.push(message));
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async (_host, _material, _jump, ask) => {
    expect(await ask!(prompt)).toBeNull(); throw new Error('authentication cancelled');
  });
  const connecting = server.dispatch({ method: 'connect', host });
  const failed = expect(connecting).rejects.toThrow('authentication cancelled');
  const input = events.find((event) => 'event' in event && event.event.type === 'input-open');
  if (!input || !('event' in input) || input.event.type !== 'input-open') throw new Error('Missing input');
  vi.setSystemTime(input.event.value.expiresAt + 1);
  await expect(server.dispatch({ method: 'answer-input', requestId: input.event.value.id, answer: 'expired-private-answer' })).rejects.toThrow('Input request expired');
  await failed; expect(JSON.stringify(events)).not.toContain('expired-private-answer'); expect(vi.getTimerCount()).toBe(0);
});
it('registers a private input before publishing it and isolates its answer from public events', async () => {
  vi.useFakeTimers(); const events: RuntimeMessage[] = []; let answer!: Promise<unknown>;
  const server = new WorkerServer((message) => {
    events.push(message);
    if ('event' in message && message.event.type === 'input-open') answer = server.dispatch({ method: 'answer-input', requestId: message.event.value.id, answer: 'synthetic-private-answer' });
  });
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async (_host, _material, _jump, ask) => {
    expect(await ask!(prompt)).toBe('synthetic-private-answer');
  });
  await server.dispatch({ method: 'connect', host }); await answer;
  expect(JSON.stringify(events)).not.toContain('synthetic-private-answer'); expect(vi.getTimerCount()).toBe(0);
});
it('rejects simultaneous duplicate connections and mismatched challenge recipients', async () => {
  const events: RuntimeMessage[] = [], server = new WorkerServer((message) => events.push(message));
  let finish!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(SshTransport.prototype, 'connect').mockImplementation(async (_host, _material, _jump, ask) => {
    expect(await ask!({ ...prompt, hostId: 'wrong-host' })).toBeNull();
    expect(await ask!({ ...prompt, username: 'root' })).toBeNull();
    await new Promise<void>((resolve) => { finish = resolve; entered(); });
  });
  const connecting = server.dispatch({ method: 'connect', host });
  await waiting;
  await expect(server.dispatch({ method: 'connect', host })).rejects.toThrow('already in progress');
  finish(); await connecting;
  expect(events.some((event) => 'event' in event && event.event.type === 'input-open')).toBe(false);
});
