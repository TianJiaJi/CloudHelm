import { expect, it } from 'vitest';
import type { ContextUsageView } from '@cloudhelm/contracts';
import { contextUsagePresentation } from './context-usage.js';
const usage: ContextUsageView = { model: { provider: 'fixture', modelId: 'fixture' }, request: 1, usedTokens: 1000,
  contextWindow: 32000, source: 'provider', updatedAt: 1,
  budget: { contextWindow: 32000, usedTokens: 10000, outputReserve: 8192, safetyMargin: 640, availableInput: 13168, source: 'estimate' } };
it('renders backend input capacity, not raw SDK remaining window', () => {
  const result = contextUsagePresentation(usage);
  expect(result.remaining).toBe(41); expect(result.label).toBe('可输入约 41%');
  expect(result.details).toContain('8,192'); expect(result.details).toContain('安全余量 640'); expect(result.details).toContain('13,168');
});
it('discloses a pending input-index reserve as already included, without subtracting twice', () => {
  const result = contextUsagePresentation({ ...usage, budget: { ...usage.budget!, pendingInputReserve: 4096 } });
  expect(result.remaining).toBe(41); expect(result.details).toContain('待发意图索引预留 4,096（已计入活动估算）');
});
it('shows actual provider/model and distinguishes catalog from configured/default custom capacity', () => {
  const configured = contextUsagePresentation({ ...usage, capacity: { contextWindow: 32000, maxOutputTokens: 8192, source: 'custom-settings' } });
  expect(configured.details).toContain('fixture / fixture'); expect(configured.details).toContain('自定义配置（含兼容默认值，未向模型探测）');
  expect(contextUsagePresentation({ ...usage, capacity: { contextWindow: 32000, maxOutputTokens: 8192, source: 'catalog' } }).details).toContain('内置模型目录');
});
it('does not imply compaction success freed any space', () => {
  const full = { ...usage, budget: { ...usage.budget!, usedTokens: 64000, availableInput: 0 } };
  expect(contextUsagePresentation(full, 'complete').label).toBe('可输入约 0%');
  expect(contextUsagePresentation(full, 'running').label).toBe('正在整理上下文…');
});
it('keeps legacy usage visibly distinct from authoritative input capacity', () => {
  const old = contextUsagePresentation({ ...usage, budget: undefined });
  expect(old.label).toBe('剩余 97%'); expect(old.details).toContain('窗口剩余不代表可输入空间');
});
it('never presents corrupt or missing capacity as an input allowance', () => {
  expect(contextUsagePresentation().remaining).toBeNull();
  expect(contextUsagePresentation({ ...usage, budget: { ...usage.budget!, availableInput: NaN } }).remaining).toBeNull();
});
