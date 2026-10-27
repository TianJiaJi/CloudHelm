import { expect, it, vi } from 'vitest';
import { contextBudget, createRequestBudget, reserveRoundRequest, type IdleCompactionLease, type ModelRequestAttempt } from '@cloudhelm/core';
import { assertPreparedInput, taskPreparation, type PreparationSnapshot } from './task-preparation.js';
function fixture() {
  const controller = new AbortController(); let generation = 'one';
  const profile = { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'private-fixture', baseUrl: 'http://localhost/v1' };
  const snapshot: PreparationSnapshot = { budget: contextBudget({ contextWindow: 32000, maxOutputTokens: 8192, historyTokens: 10000, frameTokens: 2000 }),
    historyTokens: 10000, hasHistory: true, modelIdle: true, remoteIdle: true, revision: 'context-one' };
  const attempt: ModelRequestAttempt = { logicalRequestId: 'compact', purpose: 'compaction', attempt: 1, transport: 'http' };
  const reserve = vi.fn(async () => reserveRoundRequest(createRequestBudget('round'))); const charged = vi.fn();
  const compactIdle = vi.fn(async (lease: IdleCompactionLease) => { lease.assertValid(); await lease.reserve(profile, attempt, lease.signal); });
  const context = taskPreparation({ agent: { compactIdle }, signal: controller.signal, expectedProfile: profile,
    profile: () => profile, generation: () => generation, snapshot: () => snapshot, reserve, charged });
  return { context, profile, snapshot, controller, reserve, charged, compactIdle, change: () => { generation = 'two'; } };
}
it('uses only the supplied compaction reservation without changing model/remote state', async () => {
  const f = fixture(); await f.context.compact(f.controller.signal);
  expect(f.compactIdle).toHaveBeenCalledOnce(); expect(f.reserve).toHaveBeenCalledOnce();
  expect(f.charged).toHaveBeenCalledWith(f.profile, expect.objectContaining({ totalUsed: 1 }),
    expect.objectContaining({ logicalRequestId: 'compact', purpose: 'compaction', attempt: 1, transport: 'http' }));
  expect(f.snapshot).toMatchObject({ modelIdle: true, remoteIdle: true });
});
it.each(['modelIdle', 'remoteIdle'] as const)('refuses active %s without invoking native compact or reserving', async (field) => {
  const f = fixture(); f.snapshot[field] = false;
  await expect(f.context.compact(f.controller.signal)).rejects.toThrow('未空闲');
  expect(f.compactIdle).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});
it('checks policy again after a committed reservation, never refunding or publishing it as dispatched', async () => {
  const f = fixture(); let used = 0;
  f.reserve.mockImplementation(async () => { used++; f.change(); return reserveRoundRequest(createRequestBudget('round')); });
  await expect(f.context.compact(f.controller.signal)).rejects.toThrow('控制已变化');
  expect(used).toBe(1); expect(f.charged).not.toHaveBeenCalled();
});
it.each(['apiKey', 'modelId', 'baseUrl'] as const)('rejects changed %s without exposing its value', async (field) => {
  const f = fixture(); f.profile[field] = 'changed-private-fixture';
  await expect(f.context.compact(f.controller.signal)).rejects.toThrow('模型或任务控制已变化');
  expect(f.reserve).not.toHaveBeenCalled();
});
it('checks cancellation even for snapshot-only preparation', () => {
  const f = fixture(); f.controller.abort(); expect(() => f.context.snapshot()).toThrow();
});
it('checks final context version and available input before allowing dispatch', () => {
  const f = fixture(); expect(() => assertPreparedInput(f.snapshot, 'old', 'small')).toThrow('版本已失效');
  expect(() => assertPreparedInput(f.snapshot, f.snapshot.revision, 'small')).not.toThrow();
  expect(() => assertPreparedInput(f.snapshot, f.snapshot.revision, 'x'.repeat(100000))).toThrow('可输入空间不足');
});
