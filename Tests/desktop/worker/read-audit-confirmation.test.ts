import { afterEach, expect, it, vi } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { createAuditedRemoteReader } from '../../../apps/desktop/src/worker/audited-remote-read.js';
import { OperationCommitClient } from '../../../apps/desktop/src/worker/operation-commit-client.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
  status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
afterEach(() => vi.useRealTimers());

it('does not read or retry after an audit-ack timeout, including a late successful acknowledgment', async () => {
  vi.useFakeTimers();
  const post = vi.fn((_message: Extract<RuntimeMessage, { commitOperation: unknown }>) => {});
  const client = new OperationCommitClient(post);
  const rawRead = vi.fn(async () => ({ content: 'not-delivered', bytes: 13, truncated: false, mode: 0o600, uid: 1, gid: 1 }));
  const read = createAuditedRemoteReader('task', [host], rawRead, { commitOperation: (op) => client.commit(op),
    event() {}, requestApproval: async () => false, cancelApproval() {} }, () => {}, new Map())!;
  const pending = read('host', '/srv/plain.txt', '/');
  const rejected = expect(pending).rejects.toThrow('持久化确认');
  await vi.advanceTimersByTimeAsync(30000); await rejected;
  const submitted = post.mock.calls[0]![0].commitOperation;
  client.resolve({ id: submitted.id, taskId: 'task', operationId: submitted.value.id, committed: true });
  await Promise.resolve();
  expect(rawRead).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('has no legacy read bypass when the durable writer is missing', async () => {
  const rawRead = vi.fn(async () => ({ content: 'not-delivered', bytes: 13, truncated: false, mode: 0o600, uid: 1, gid: 1 }));
  const operations = new Map<string, OperationView>();
  const read = createAuditedRemoteReader('task', [host], rawRead, { event() {}, requestApproval: async () => false, cancelApproval() {} },
    () => {}, operations)!;
  await expect(read('host', '/srv/plain.txt', '/')).rejects.toThrow('持久化确认');
  expect(rawRead).not.toHaveBeenCalled(); expect(operations.size).toBe(0);
});
