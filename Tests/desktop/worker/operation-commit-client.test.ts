import { afterEach, expect, it, vi } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { OperationCommitClient, commitOperationSnapshot } from '../../../apps/desktop/src/worker/operation-commit-client.js';
const operation: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'synthetic', status: 'running', createdAt: 1 };
afterEach(() => vi.useRealTimers());
function setup() {
  const post = vi.fn(), client = new OperationCommitClient(post);
  const acknowledge = (patch: Record<string, unknown> = {}) => client.resolve({ id: post.mock.calls[0]![0].commitOperation.id,
    taskId: 'task', operationId: 'op', committed: true, ...patch });
  return { post, client, acknowledge };
}
it('requires a recipient-bound durable acknowledgment and detaches the submitted snapshot', async () => {
  vi.useFakeTimers(); const f = setup(), value = structuredClone(operation);
  let completed = false;
  const pending = f.client.commit(value).then(() => { completed = true; });
  value.preview = 'changed'; await Promise.resolve();
  expect(completed).toBe(false); expect(f.post.mock.calls[0]![0].commitOperation.value.preview).toBe('synthetic');
  f.acknowledge(); await pending; f.acknowledge();
  expect(completed).toBe(true); expect(f.post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it.each([{ committed: false }, { taskId: 'foreign' }, { operationId: 'foreign' }, { committed: 'true' }])('rejects invalid acknowledgment %j', async (patch) => {
  const f = setup(), pending = f.client.commit(operation), failed = expect(pending).rejects.toThrow('持久化确认');
  f.acknowledge(patch); await failed; f.acknowledge(); expect(f.post).toHaveBeenCalledOnce();
});
it('does not retry or accept a late acknowledgment after timeout', async () => {
  vi.useFakeTimers(); const f = setup(), pending = f.client.commit(operation), failed = expect(pending).rejects.toThrow('持久化确认');
  await vi.advanceTimersByTimeAsync(30000); await failed; f.acknowledge();
  expect(f.post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('rejects pending and new requests when closed', async () => {
  vi.useFakeTimers(); const f = setup(), pending = f.client.commit(operation), failed = expect(pending).rejects.toThrow('持久化确认');
  f.client.close(); await failed; f.acknowledge();
  await expect(f.client.commit(operation)).rejects.toThrow('持久化确认');
  expect(f.post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('does not dispatch a new stop without durable authority or expose its storage exception', async () => {
  const control: OperationView = { ...operation, processControl: { kind: 'interrupt', jobId: 'job', targetOperationId: 'target' } };
  await expect(commitOperationSnapshot(control)).rejects.toThrow('持久化确认');
  await expect(commitOperationSnapshot(control, async () => { throw new Error('private storage detail'); }))
    .rejects.toThrow('持久化确认');
});
