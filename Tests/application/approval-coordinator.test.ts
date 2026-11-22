import { afterEach, expect, it, vi } from 'vitest';
import type { ApprovalWaitBinding } from '@cloudhelm/core';
import { ApprovalCoordinator, type ApprovalEvents } from '../../packages/application/src/approval-coordinator.js';

const coordinators: ApprovalCoordinator<ApprovalWaitBinding>[] = [];
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.dispose(); vi.useRealTimers(); });
const binding = (id = 'approval', taskId = 'task'): ApprovalWaitBinding => ({ id, taskId, operationId: `op-${id}`,
  hostId: 'host', fingerprint: 'exact-fingerprint', expiresAt: Date.now() + 1000, hardExpiresAt: Date.now() + 10_000 });
function setup(events: Partial<ApprovalEvents<ApprovalWaitBinding>> = {}) {
  vi.useFakeTimers();
  const opened = vi.fn(events.opened ?? (() => {})), reminder = vi.fn(events.reminder ?? (() => {})), closed = vi.fn(events.closed ?? (() => {}));
  const coordinator = new ApprovalCoordinator({ opened, reminder, closed });
  coordinators.push(coordinator);
  return { coordinator, opened, reminder, closed };
}

it('registers before synchronous publication, consumes once and prevents ID reuse', async () => {
  const f = setup({ opened: (view) => f.coordinator.decide(view.id, true) });
  const request = binding();
  await expect(f.coordinator.request(request)).resolves.toBe(true);
  expect(() => f.coordinator.decide(request.id, false)).toThrow('Approval expired');
  await expect(f.coordinator.request(request)).rejects.toThrow('already used');
  expect(f.closed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('keeps private bindings immutable when caller and projection mutate their copies', async () => {
  const f = setup({ opened: (view) => { view.taskId = 'other'; view.expiresAt = 0; } });
  const request = binding();
  const pending = f.coordinator.request(request);
  const failed = expect(pending).rejects.toMatchObject({ outcome: 'stale' });
  request.taskId = 'other'; request.id = 'other';
  f.coordinator.cancelWhere((view) => view.taskId === 'other');
  expect(f.closed).not.toHaveBeenCalled();
  f.coordinator.cancelWhere((view) => view.taskId === 'task');
  await failed; expect(vi.getTimerCount()).toBe(0);
});

it('reminds at soft expiry, renews only time, and retains exact content binding', async () => {
  const f = setup(); const request = binding(); const pending = f.coordinator.request(request);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reminder).toHaveBeenCalledExactlyOnceWith(request.id);
  expect(f.closed).not.toHaveBeenCalled();
  expect(f.coordinator.renew(request.id, 1000)).toEqual({ expiresAt: request.expiresAt + 1000, hardExpiresAt: request.hardExpiresAt });
  expect(f.opened.mock.calls[1]![0]).toMatchObject({ fingerprint: request.fingerprint, operationId: request.operationId, renewals: 1 });
  f.coordinator.decide(request.id, false); await expect(pending).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['decide', 'renew'] as const)('checks hard expiry before %s even when the timer has not fired', async (action) => {
  const f = setup(); const request = binding(); const pending = f.coordinator.request(request);
  const failed = expect(pending).rejects.toMatchObject({ outcome: 'expired' });
  vi.setSystemTime(request.hardExpiresAt!);
  if (action === 'decide') expect(() => f.coordinator.decide(request.id, true)).toThrow('Approval expired');
  else expect(f.coordinator.renew(request.id)).toBeUndefined();
  await failed; expect(f.closed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['opened', 'closed', 'reminder'] as const)('fails closed and clears timers when publishing %s fails', async (event) => {
  const f = setup({ [event]: () => { throw new Error('private transport detail'); } });
  const pending = f.coordinator.request(binding());
  const failed = event === 'reminder' ? expect(pending).rejects.toMatchObject({ outcome: 'canceled' })
    : expect(pending).rejects.toThrow('Approval channel unavailable');
  if (event === 'closed') expect(() => f.coordinator.decide('approval', true)).toThrow('Approval channel unavailable');
  if (event === 'reminder') await vi.advanceTimersByTimeAsync(1000);
  await failed; expect(vi.getTimerCount()).toBe(0);
});

it('does not consume a valid approval for foreign IDs or malformed responses', async () => {
  const f = setup(); const pending = f.coordinator.request(binding());
  expect(() => f.coordinator.decide('foreign', true)).toThrow('Approval expired');
  expect(() => f.coordinator.decide('approval', 'true')).toThrow('Invalid approval decision');
  f.coordinator.decide('approval', false); await expect(pending).resolves.toBe(false);
});

it('cancels only matching tasks and rejects all outstanding waits on disposal', async () => {
  const f = setup(); const a = f.coordinator.request(binding('a', 'one')), b = f.coordinator.request(binding('b', 'two'));
  const failedA = expect(a).rejects.toMatchObject({ outcome: 'stale' });
  const failedB = expect(b).rejects.toMatchObject({ outcome: 'canceled' });
  f.coordinator.cancelWhere((view) => view.taskId === 'one'); await failedA;
  expect(f.closed.mock.calls).toEqual([['a']]);
  f.coordinator.dispose(); f.coordinator.dispose(); await failedB;
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.coordinator.request(binding('c'))).rejects.toThrow('unavailable');
});

it.each([NaN, Infinity, -1, 0])('rejects invalid renewal %s without changing the binding', async (amount) => {
  const f = setup(); const pending = f.coordinator.request(binding());
  expect(f.coordinator.renew('approval', amount)).toBeUndefined();
  expect(f.opened).toHaveBeenCalledOnce();
  f.coordinator.decide('approval', true); await expect(pending).resolves.toBe(true);
});

it('does not accept a non-finite or inverted hard deadline', async () => {
  const f = setup();
  for (const hardExpiresAt of [NaN, Infinity, Date.now()]) {
    await expect(f.coordinator.request({ ...binding(), hardExpiresAt })).rejects.toThrow('Invalid approval deadline');
  }
  expect(f.opened).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
