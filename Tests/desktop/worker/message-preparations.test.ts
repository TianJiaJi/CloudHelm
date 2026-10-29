import { expect, it, vi } from 'vitest';
import { contextBudget, type InputPreparationContext } from '@cloudhelm/core';
import type { RuntimeCall, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import { MessagePreparations } from '../../../apps/desktop/src/worker/message-preparations.js';
function setup() {
  const profile: RuntimeProfile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'fixture-only',
    baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 8192 };
  const call: Extract<RuntimeCall, { method: 'prepare-message' }> = { method: 'prepare-message', requestId: 'prepare', taskId: 'task',
    document: { requestId: 'prepare', parts: [{ type: 'text', text: 'x'.repeat(10000) }] }, bodies: [], profile, usedTokens: 0 };
  let snapshot = { budget: contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 25000, frameTokens: 1000 }),
    historyTokens: 25000, hasHistory: true, modelIdle: true, remoteIdle: true, revision: 'before' };
  const compact = vi.fn(async (_signal: AbortSignal) => {
    snapshot = { ...snapshot, revision: 'after', historyTokens: 1000,
      budget: contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 }) };
  });
  const context: InputPreparationContext = { snapshot: () => snapshot, compact };
  const runner = { preparationContext: vi.fn((_id: string, _profile: RuntimeProfile, _signal: AbortSignal) => context),
    preparationSnapshot: () => snapshot };
  const budget = { request: vi.fn(async () => { throw new Error('Unexpected summary request'); }) };
  const event = vi.fn(); const jobs = new MessagePreparations(budget, event);
  return { call, runner, context, compact, budget, event, jobs, snapshot };
}
it('routes existing-session preparation through idle compaction and returns its final version', async () => {
  const f = setup(); const result = await f.jobs.prepare(f.call, f.runner);
  expect(result.text).toBe('x'.repeat(10000)); expect(f.compact).toHaveBeenCalledOnce();
  expect(result.preparedContext).toEqual({ beforeRevision: 'after', revision: 'after' });
  expect(f.budget.request).not.toHaveBeenCalled();
});
it('fails closed for a missing task instead of trusting stale UI usage', async () => {
  const f = setup(); await expect(f.jobs.prepare(f.call)).rejects.toThrow('运行已失效');
  expect(f.budget.request).not.toHaveBeenCalled();
});
it.each(['modelIdle', 'remoteIdle'] as const)('does not compact or summarize oversized input with %s false', async (field) => {
  const f = setup(); f.snapshot[field] = false;
  await expect(f.jobs.prepare(f.call, f.runner)).rejects.toThrow('请稍后发送');
  expect(f.compact).not.toHaveBeenCalled(); expect(f.budget.request).not.toHaveBeenCalled();
});
it('permits small active input through the same preparation path', async () => {
  const f = setup(); f.snapshot.modelIdle = false;
  f.snapshot.budget = contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 });
  f.call.document.parts = [{ type: 'text', text: 'small steer' }];
  expect((await f.jobs.prepare(f.call, f.runner)).text).toBe('small steer');
  expect(f.compact).not.toHaveBeenCalled(); expect(f.budget.request).not.toHaveBeenCalled();
});
it('cancels the existing job without dispatch or a second queue, then permits an explicit retry', async () => {
  const f = setup(); const original = f.compact.getMockImplementation()!;
  f.compact.mockImplementationOnce((signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
  }));
  const pending = f.jobs.prepare(f.call, f.runner);
  await expect(f.jobs.prepare(f.call, f.runner)).rejects.toThrow('正在准备');
  await expect(f.jobs.prepare({ ...f.call, requestId: 'other' }, f.runner)).rejects.toThrow('正在准备');
  f.jobs.cancelTask('task'); await expect(pending).rejects.toThrow('canceled');
  f.compact.mockImplementation(original); await expect(f.jobs.prepare(f.call, f.runner)).resolves.toHaveProperty('preparedContext');
  expect(f.compact).toHaveBeenCalledTimes(2); expect(f.budget.request).not.toHaveBeenCalled();
});
it('does not relabel a late context change as a newly prepared version', async () => {
  const f = setup(); f.call.document.parts = [{ type: 'text', text: 'small' }]; let reads = 0;
  f.snapshot.budget = contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 });
  f.context.snapshot = () => ({ ...f.snapshot, revision: ++reads <= 2 ? 'before' : 'late' });
  await expect(f.jobs.prepare(f.call, f.runner)).rejects.toThrow('活动上下文已变化');
});
it('returns separate baseline and prospective authorization versions without granting authorization', async () => {
  const f = setup(); f.call.document.parts = [{ type: 'text', text: 'small' }];
  f.snapshot.budget = contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 1000, frameTokens: 1000 });
  f.context.snapshot = () => ({ ...f.snapshot, revision: 'with-selected-files' });
  f.call.localScopes = [{ path: '/selected/file.txt', kind: 'file' }];
  const result = await f.jobs.prepare(f.call, f.runner);
  expect(result.preparedContext).toEqual({ beforeRevision: 'before', revision: 'with-selected-files' });
  expect(f.runner.preparationContext).toHaveBeenCalledWith('prepare', f.call.profile, expect.any(AbortSignal), f.call.localScopes);
  expect(f.budget.request).not.toHaveBeenCalled();
});
