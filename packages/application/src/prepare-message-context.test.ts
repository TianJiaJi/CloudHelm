import { expect, it, vi } from 'vitest';
import { contextBudget, type ContentModelPort, type InputPreparationContext, type MessageDocument, type ReferenceBody } from '@cloudhelm/core';
import { prepareMessageWithContext } from './prepare-message-context.js';
function fixture() {
  const reference = { id: 'paste', kind: 'paste' as const, capturedAt: 1 };
  const document: MessageDocument = { requestId: 'request', parts: [{ type: 'text', text: '解释' }, { type: 'reference', reference }] };
  const bodies: ReferenceBody[] = [{ reference, original: 'x'.repeat(2000) }];
  const model: ContentModelPort = { contextWindow: 10000, reserveTokens: 1000, estimate: (text) => text.length, summarize: vi.fn(async () => '简短摘要') };
  let snapshot = { budget: contextBudget({ contextWindow: 10000, maxOutputTokens: 1000, historyTokens: 8000, frameTokens: 0 }),
    historyTokens: 8000, hasHistory: true, modelIdle: true, remoteIdle: true, revision: 'before' };
  const compact = vi.fn(async () => { snapshot = { ...snapshot, revision: 'after', budget: contextBudget({ contextWindow: 10000, maxOutputTokens: 1000, historyTokens: 1000, frameTokens: 0 }) }; });
  const context: InputPreparationContext = { snapshot: () => snapshot, compact };
  const controller = new AbortController();
  return { document, bodies, model, compact, controller, context, snapshot,
    run: () => prepareMessageWithContext(document, bodies, model, context, controller.signal) };
}
it('compacts idle history before summarizing original references', async () => {
  const f = fixture(); const result = await f.run();
  expect(f.compact).toHaveBeenCalledOnce(); expect(f.model.summarize).not.toHaveBeenCalled();
  expect(result.bodies[0]?.original).toBe(f.bodies[0]?.original); expect(result.bodies[0]?.summary).toBeUndefined();
});
it.each(['modelIdle', 'remoteIdle'] as const)('preserves an oversized draft without compaction or summarization when %s is false', async (field) => {
  const f = fixture(); f.snapshot[field] = false;
  await expect(f.run()).rejects.toThrow('请稍后发送');
  expect(f.compact).not.toHaveBeenCalled(); expect(f.model.summarize).not.toHaveBeenCalled();
});
it('summarizes references directly for a new session or little history', async () => {
  for (const hasHistory of [true, false]) {
    const f = fixture(); f.snapshot.hasHistory = hasHistory; f.snapshot.historyTokens = 100;
    await f.run(); expect(f.compact).not.toHaveBeenCalled(); expect(f.model.summarize).toHaveBeenCalledOnce();
  }
});
it('permits a small active-session input for the existing steer path without compaction', async () => {
  const f = fixture(); f.snapshot.modelIdle = false; f.bodies[0]!.original = 'small';
  expect((await f.run()).text).toContain('small');
  expect(f.compact).not.toHaveBeenCalled(); expect(f.model.summarize).not.toHaveBeenCalled();
});
it('does not compact history when input already fits', async () => {
  const f = fixture(); f.bodies[0]!.original = 'small'; await f.run();
  expect(f.compact).not.toHaveBeenCalled(); expect(f.model.summarize).not.toHaveBeenCalled();
});
it('does not repeat compaction or hide an oversized kept message behind success', async () => {
  const f = fixture();
  f.compact.mockImplementation(async () => {
    f.snapshot.revision = 'compacted-but-still-full';
    f.snapshot.budget = contextBudget({ contextWindow: 10000, maxOutputTokens: 1000, historyTokens: 20000, frameTokens: 0 });
  });
  await expect(f.run()).rejects.toThrow('整理后输入空间仍不足');
  expect(f.compact).toHaveBeenCalledOnce(); expect(f.model.summarize).not.toHaveBeenCalled();
  expect(f.bodies[0]?.summary).toBeUndefined();
});
it('checks model capacity binding before spending any compaction requests', async () => {
  const f = fixture(); f.model.contextWindow = 20000;
  await expect(f.run()).rejects.toThrow('模型容量已变化');
  expect(f.compact).not.toHaveBeenCalled(); expect(f.model.summarize).not.toHaveBeenCalled();
});
it('cancellation during compaction never progresses to reference preparation', async () => {
  const f = fixture(); f.compact.mockImplementation(async () => { f.controller.abort(); });
  await expect(f.run()).rejects.toThrow(); expect(f.model.summarize).not.toHaveBeenCalled();
  expect(f.bodies[0]?.summary).toBeUndefined();
});
it('rejects stale prepared content instead of silently dispatching it into changed context', async () => {
  const f = fixture(); f.snapshot.hasHistory = false;
  f.model.summarize = async () => { f.snapshot.revision = 'changed'; return 'short'; };
  await expect(f.run()).rejects.toThrow('活动上下文已变化'); expect(f.bodies[0]?.summary).toBeUndefined();
});
