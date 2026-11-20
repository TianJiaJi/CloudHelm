import { afterEach, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@cloudhelm/contracts';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

// This unit uses the real Worker request/dispatch handlers, without SSH or Pi.
interface ApprovalPort { requestApproval(view: ApprovalView): Promise<boolean>; cancelApproval(id: string): void }
const view = (): ApprovalView => ({ id: 'review', taskId: 'task', operationId: 'op', hostId: 'host',
  fingerprint: 'bound-fingerprint', title: 'fixture', explanation: 'fixture', preview: 'customctl inspect', expiresAt: Date.now() + 1000 });
/** Soft deadline 10 minutes out, hard ceiling 60 minutes out. */
const renewable = (): ApprovalView => ({ ...view(), expiresAt: Date.now() + 600_000, hardExpiresAt: Date.now() + 3_600_000 });
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

it('re-arms the reminder when renewed and reports the remaining window', async () => {
  const f = setup(), request = renewable(), pending = f.port.requestApproval(request);
  const count = (type: string) => f.messages.filter((message) => 'event' in message && message.event.type === type).length;
  const openedWith = (renewals: number | undefined) => f.messages.filter((message) => 'event' in message
    && message.event.type === 'approval-open' && message.event.value.renewals === renewals).length;
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(openedWith(undefined)).toBe(1);
  await expect(f.server.dispatch({ method: 'renew-approval', approvalId: 'review' })).resolves.toMatchObject({
    expiresAt: request.expiresAt + 600_000, hardExpiresAt: request.hardExpiresAt });
  expect(openedWith(1)).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(count('approval-reminder')).toBe(0);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(count('approval-reminder')).toBe(1);
  expect(count('approval-close')).toBe(0);
  f.port.cancelApproval('review');
  await expect(pending).rejects.toMatchObject({ outcome: 'canceled' });
  expect(vi.getTimerCount()).toBe(0);
});

it('caps renewal at five per approval and cancels at the hard deadline', async () => {
  const f = setup(), request = renewable(), pending = f.port.requestApproval(request);
  let expiresAt = request.expiresAt;
  for (let renewal = 1; renewal <= 5; renewal++) {
    expiresAt += 600_000;
    await expect(f.server.dispatch({ method: 'renew-approval', approvalId: 'review' })).resolves.toMatchObject({ expiresAt });
    expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-open'
      && message.event.value.renewals === renewal)).toHaveLength(1);
  }
  await expect(f.server.dispatch({ method: 'renew-approval', approvalId: 'review' })).rejects.toThrow('审批续期不可用或次数已用尽');
  const failed = expect(pending).rejects.toMatchObject({ outcome: 'expired' });
  await vi.advanceTimersByTimeAsync(3_600_000);
  await failed;
  expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-close')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('reminds at the soft deadline without cancelling and still decides afterwards', async () => {
  const f = setup(), pending = f.port.requestApproval(renewable());
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-reminder')).toHaveLength(1);
  expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-close')).toHaveLength(0);
  await f.server.dispatch({ method: 'decide-approval', approvalId: 'review', approved: true });
  await expect(pending).resolves.toBe(true);
  expect(f.messages.filter((message) => 'event' in message && message.event.type === 'approval-close')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
