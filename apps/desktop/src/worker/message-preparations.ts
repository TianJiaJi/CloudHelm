import { prepareMessageWithContext } from '@cloudhelm/application';
import { contentModel, modelCapacity } from '@cloudhelm/adapters';
import type { InputPreparationContext } from '@cloudhelm/core';
import { initialContext } from './initial-context.js';
import type { AppEvent } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import type { RequestBudgetClient } from './request-budget-client.js';
import type { TaskRunner } from './task-runner.js';

type PrepareCall = Extract<RuntimeCall, { method: 'prepare-message' }>;
type Runner = Pick<TaskRunner, 'preparationSnapshot' | 'preparationContext'>;
/** Owns the original preparing-job map, not a second send queue. */
export class MessagePreparations {
  private readonly jobs = new Map<string, { taskId?: string; controller: AbortController }>();
  constructor(private readonly budget: Pick<RequestBudgetClient, 'request'>, private readonly event: (event: AppEvent) => void) {}
  cancel(id: string): void { this.jobs.get(id)?.controller.abort(); }
  cancelTask(taskId: string): void { for (const job of this.jobs.values()) if (job.taskId === taskId) job.controller.abort(); }
  cancelAll(): void { for (const job of this.jobs.values()) job.controller.abort(); }
  async prepare(call: PrepareCall, runner?: Runner) {
    if (this.jobs.has(call.requestId) || (call.taskId && [...this.jobs.values()].some((job) => job.taskId === call.taskId)))
      throw new Error('消息正在准备，请先取消或等待已有准备完成');
    if (call.taskId && !runner) throw new Error('对话运行已失效，不能使用旧上下文估算');
    const controller = new AbortController(); this.jobs.set(call.requestId, { taskId: call.taskId, controller });
    const timer = setTimeout(() => controller.abort(), 600_000);
    try {
      const model = contentModel(call.profile, async (attempt, signal) => {
        controller.signal.throwIfAborted();
        const value = await this.budget.request({ kind: 'summary', requestId: call.requestId, attempt }, signal);
        controller.signal.throwIfAborted();
        if (value.kind !== 'summary' || value.scopeId !== call.requestId) throw new Error('Summary budget binding changed');
        this.event({ type: 'message-preparation', requestId: call.requestId, status: 'compressing', summaryRequests: { used: value.used, limit: 32 } });
      });
      const initial = runner ? undefined : await initialContext(call.profile, call.hosts ?? [], call.localScopes ?? [], controller.signal);
      const source: InputPreparationContext = runner
        ? runner.preparationContext(call.requestId, call.profile, controller.signal, call.localScopes)
        : { snapshot: () => initial!, compact: async () => { throw new Error('新会话没有可整理的历史'); } };
      const context: InputPreparationContext = { compact: source.compact, snapshot: () => {
        const snapshot = source.snapshot();
        this.event({ type: 'message-preparation', requestId: call.requestId, status: 'checking', context: {
          budget: snapshot.budget, capacity: modelCapacity(call.profile), model: { provider: call.profile.provider, modelId: call.profile.modelId }, request: 0,
          usedTokens: snapshot.budget.usedTokens, contextWindow: snapshot.budget.contextWindow, source: snapshot.budget.source, updatedAt: Date.now()
        } });
        return snapshot;
      } };
      const prepared = await prepareMessageWithContext(call.document, call.bodies, model, context, controller.signal, (id) => {
        const part = call.document.parts.find((part) => part.type === 'reference' && part.reference.id === id);
        this.event({ type: 'message-preparation', requestId: call.requestId,
          referenceId: part?.type === 'reference' ? part.instanceId ?? id : id, status: 'compressing' });
      });
      controller.signal.throwIfAborted();
      if (context.snapshot().revision !== prepared.contextRevision) throw new Error('活动上下文已变化，消息未投递');
      return { ...prepared, preparedContext: runner ? { beforeRevision: runner.preparationSnapshot().revision, revision: prepared.contextRevision } : undefined };
    } finally { clearTimeout(timer); this.jobs.delete(call.requestId); }
  }
}
