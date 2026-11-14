import { afterEach, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@cloudhelm/contracts';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

// This unit uses the real Worker request/dispatch handlers, without SSH or Pi.
interface ApprovalPort { requestApproval(view: ApprovalView): Promise<boolean>; cancelApproval(id: string): void }
const view = (): ApprovalView => ({ id: 'review', taskId: 'task', operationId: 'op', hostId: 'host',
  fingerprint: 'bound-fingerprint', title: 'fixture', explanation: 'fixture', preview: 'customctl inspect', expiresAt: Date.now() + 1000 });
afterEach(() => vi.useRealTimers());
function setup(send?: (message: RuntimeMessage) => void) {
  vi.useFakeTimers();
  const messages: RuntimeMessage[] = [];
  const server = new WorkerServer((message) => { messages.push(message); send?.(message); });
  return { server, port: server as unknown as ApprovalPort, messages };
}

it('registers before publication and consumes an immediate approval only once', async () => {
  const calls: Promise<unknown>[] = [];
  const f = setup((message) => {
    if ('event' in message && message.event.type === 'approval-open')
      calls.push(f.server.dispatch({ method: 'decide-approval', approvalId: message.event.value.id, approved: true }));
  });
  const pending = f.port.requestApproval(view());
  await vi.advanceTimersByTimeAsync(0); await Promise.all(calls);
  await expect(pending).resolves.toBe(true);
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: true })).rejects.toThrow('Approval expired');
  expect(vi.getTimerCount()).toBe(0);
});

it('checks the deadline even if the event loop has not run the expiration timer', async () => {
  const f = setup(), request = view(), pending = f.port.requestApproval(request);
  const failed = expect(pending).rejects.toMatchObject({ outcome: 'expired' });
  vi.setSystemTime(request.expiresAt);
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: request.id, approved: true })).rejects.toThrow('Approval expired');
  await failed; expect(vi.getTimerCount()).toBe(0);
});

it.each(['cancel', 'timeout', 'policy'] as const)('rejects %s with explicit lifecycle metadata instead of false', async (kind) => {
  const f = setup(), pending = f.port.requestApproval(view());
  const failed = expect(pending).rejects.toMatchObject({ outcome: kind === 'cancel' ? 'canceled' : kind === 'timeout' ? 'expired' : 'stale' });
  if (kind === 'cancel') f.port.cancelApproval('review');
  else if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1000);
  else await f.server.dispatch({ method: 'update-host-safety', hostId: 'host', mode: 'ask', revision: 2,
    protectedReadPaths: [], protectedWritePaths: [] });
  await failed;
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: true })).rejects.toThrow('Approval expired');
  expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-close')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['approval-open', 'approval-close'] as const)('fails closed and drops timers if publishing %s fails', async (event) => {
  const f = setup((message) => { if ('event' in message && message.event.type === event) throw new Error('synthetic-private-channel-detail'); });
  const pending = f.port.requestApproval(view()), failed = expect(pending).rejects.toThrow('Approval channel unavailable');
  if (event === 'approval-close') await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: true }))
    .rejects.toThrow('Approval channel unavailable');
  await failed;
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: true })).rejects.toThrow('Approval expired');
  expect(vi.getTimerCount()).toBe(0);
});

it('does not consume a valid recipient for a foreign id or non-boolean response', async () => {
  const f = setup(), pending = f.port.requestApproval(view());
  const failed = expect(pending).rejects.toMatchObject({ outcome: 'canceled' });
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'foreign', approved: true })).rejects.toThrow('Approval expired');
  await expect(f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: 'true' as unknown as boolean })).rejects.toThrow('Invalid approval decision');
  f.port.cancelApproval('review'); await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects an already expired request before opening a card', async () => {
  const f = setup(), request = view(); request.expiresAt = Date.now();
  await expect(f.port.requestApproval(request)).rejects.toMatchObject({ outcome: 'expired' });
  expect(f.messages).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
});
