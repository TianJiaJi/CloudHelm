export interface ContextBudgetInput {
  contextWindow: number;
  maxOutputTokens: number;
  /** Active projection only, never the complete JSONL archive. */
  historyTokens: number;
  frameTokens: number;
  providerUsedTokens?: number;
  previousFrameTokens?: number;
}
export interface ContextBudget {
  /** Conservative future input-index growth already included in usedTokens. */
  pendingInputReserve?: number;
  contextWindow: number; usedTokens: number; outputReserve: number;
  safetyMargin: number; availableInput: number; source: 'provider' | 'estimate';
}
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function estimateTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 2); }
export function outputTokenReserve(contextWindow: number, maxOutputTokens: number): number {
  if (!valid(contextWindow) || contextWindow < 2 || !valid(maxOutputTokens) || maxOutputTokens < 1) throw new Error('模型容量无效');
  return Math.max(1, Math.min(maxOutputTokens, Math.floor(contextWindow / 2)));
}
export function contextBudget(input: ContextBudgetInput): ContextBudget {
  const outputReserve = outputTokenReserve(input.contextWindow, input.maxOutputTokens);
  if (!valid(input.historyTokens) || !valid(input.frameTokens)) throw new Error('活动上下文估算无效');
  const provider = valid(input.providerUsedTokens) && input.providerUsedTokens > 0;
  // A restored usage sample has no known frame baseline: reserve the current
  // frame conservatively. Do not assume old system/tools/facts match new ones.
  const usedTokens = provider ? input.providerUsedTokens! + Math.max(0, input.frameTokens -
    (valid(input.previousFrameTokens) ? input.previousFrameTokens : 0)) : input.historyTokens + input.frameTokens;
  if (!valid(usedTokens)) throw new Error('活动上下文估算溢出');
  const safetyMargin = Math.max(64, Math.min(2048, Math.ceil(input.contextWindow * 0.02)));
  return { contextWindow: input.contextWindow, usedTokens, outputReserve, safetyMargin,
    availableInput: Math.max(0, input.contextWindow - outputReserve - safetyMargin - usedTokens), source: provider ? 'provider' : 'estimate' };
}

/** SDK-neutral idle compaction. The implementation must check idleness again
 * immediately before invoking native compact, which may abort active work. */
export interface InputPreparationContext {
  snapshot(): { budget: ContextBudget; historyTokens: number; hasHistory: boolean; modelIdle: boolean; remoteIdle: boolean; revision: string };
  compact(signal: AbortSignal): Promise<void>;
}
