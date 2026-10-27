import type { ContextUsageView } from '@cloudhelm/contracts';

/** Display backend budgets verbatim; never infer an input allowance from raw usage. */
export function contextUsagePresentation(usage?: ContextUsageView, compaction?: 'running' | 'complete' | 'failed') {
  const budget = usage?.budget;
  const validBudget = budget && (budget.pendingInputReserve === undefined || (Number.isSafeInteger(budget.pendingInputReserve) && budget.pendingInputReserve >= 0))
    && budget.contextWindow > 0 && budget.availableInput <= budget.contextWindow
    && [budget.contextWindow, budget.usedTokens, budget.outputReserve, budget.safetyMargin, budget.availableInput]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
  const known = !budget && usage?.usedTokens != null && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0
    && usage.contextWindow != null && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0;
  const remaining = validBudget ? Math.round(100 * budget.availableInput / budget.contextWindow)
    : known ? Math.max(0, Math.min(100, Math.round(100 * (1 - usage.usedTokens! / usage.contextWindow!)))) : null;
  const label = compaction === 'running' ? '正在整理上下文…' : validBudget
    ? `可输入${budget.source === 'estimate' ? '约' : ''} ${remaining}%`
    : remaining === null ? '上下文待统计' : `${usage?.source === 'estimate' ? '约剩余' : '剩余'} ${remaining}%`;
  const details = validBudget ? `活动上下文 ${budget.usedTokens.toLocaleString()} / ${budget.contextWindow.toLocaleString()} tokens\n输出预留 ${budget.outputReserve.toLocaleString()} · 安全余量 ${budget.safetyMargin.toLocaleString()}${budget.pendingInputReserve ? `\n待发意图索引预留 ${budget.pendingInputReserve.toLocaleString()}（已计入活动估算）` : ''}\n可输入 ${budget.availableInput.toLocaleString()} tokens\n${budget.source === 'provider' ? '基于有效模型用量与当前框架调整' : '保守 UTF-8 估算（系统提示、工具和活动历史）'}`
    : known ? `已用 ${usage.usedTokens!.toLocaleString()} / ${usage.contextWindow!.toLocaleString()} tokens\n旧用量未提供输出预留，窗口剩余不代表可输入空间`
    : '输入预算待核对；发送准备时由后端计算';
  const capacity = usage?.capacity;
  const limits = capacity ? `\n容量来源：${capacity.source === 'catalog' ? '内置模型目录' : '自定义配置（含兼容默认值，未向模型探测）'}\n模型输出上限 ${capacity.maxOutputTokens.toLocaleString()} tokens` : '';
  return { remaining, label, details: usage ? `${usage.model.provider} / ${usage.model.modelId}\n${details}${limits}\n更新于 ${new Date(usage.updatedAt).toLocaleTimeString()}` : details };
}
