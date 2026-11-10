import { afterEach, expect, it, vi } from 'vitest';
import { InputCommitClient } from '../../../apps/desktop/src/worker/input-commit-client.js';
import type { StoredConversationInput } from '@cloudhelm/contracts';
const value: StoredConversationInput = { version: 1, id: 'input', taskId: 'task', kind: 'steer', status: 'queued', text: 'synthetic',
  intent: 'synthetic', authorizationKey: 'scope', createdAt: 1, updatedAt: 1, expiresAt: 100 };
afterEach(() => vi.useRealTimers());
it.each([true, false, 'true', undefined])('accepts only a bound explicit commit confirmation: %s', async (committed) => {
  const post = vi.fn(), client = new InputCommitClient(post), promise = client.commit(value);
  const assertion = committed === true ? expect(promise).resolves.toBeUndefined() : expect(promise).rejects.toThrow('持久化确认');
  client.resolve({ id: post.mock.calls[0]![0].commitInput.id, taskId: 'task', inputId: 'input', committed });
  await assertion; expect(post).toHaveBeenCalledOnce();
});
it('rejects a foreign receipt and ignores a late correct acknowledgment without replay', async () => {
  const post = vi.fn(), client = new InputCommitClient(post), promise = client.commit(value), failed = expect(promise).rejects.toThrow('持久化确认');
  const id = post.mock.calls[0]![0].commitInput.id;
  client.resolve({ id, taskId: 'foreign', inputId: 'input', committed: true }); await failed;
  client.resolve({ id, taskId: 'task', inputId: 'input', committed: true }); expect(post).toHaveBeenCalledOnce();
});
it('times out once without dispatching or resending and suppresses private IPC errors', async () => {
  vi.useFakeTimers(); const post = vi.fn(), client = new InputCommitClient(post);
  const pending = client.commit(value), failed = expect(pending).rejects.toThrow('持久化确认');
  await vi.advanceTimersByTimeAsync(30000); await failed;
  expect(post).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  const broken = new InputCommitClient(() => { throw new Error('private storage path'); });
  await expect(broken.commit(value)).rejects.toThrow('持久化确认'); expect(vi.getTimerCount()).toBe(0);
});
