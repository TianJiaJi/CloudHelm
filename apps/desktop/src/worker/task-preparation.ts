import { estimateTextTokens, type ConversationSession, type InputPreparationContext, type ModelRequestAttempt,
  type RequestBudgetState, type SessionProfile } from '@cloudhelm/core';

export type PreparationSnapshot = ReturnType<InputPreparationContext['snapshot']>;
export function samePreparationModel(left: SessionProfile, right: SessionProfile): boolean {
  return left.provider === right.provider && left.modelId === right.modelId && left.baseUrl === right.baseUrl
    && left.apiKey === right.apiKey && left.credentialRevision === right.credentialRevision
    && left.contextWindow === right.contextWindow && left.maxTokens === right.maxTokens;
}
/** No queue or new allowance. The existing request controller owns cancellation. */
export function taskPreparation(options: {
  agent: Pick<ConversationSession, 'compactIdle'> | undefined; signal: AbortSignal; expectedProfile: SessionProfile;
  profile(): SessionProfile; generation(): string; snapshot(): PreparationSnapshot;
  reserve(attempt: ModelRequestAttempt, signal?: AbortSignal): Promise<RequestBudgetState>;
  charged(profile: SessionProfile, budget: RequestBudgetState, attempt: ModelRequestAttempt): void;
}): InputPreparationContext {
  const generation = options.generation(); const expected = structuredClone(options.expectedProfile);
  const check = () => {
    options.signal.throwIfAborted();
    if (options.generation() !== generation || !samePreparationModel(options.profile(), expected))
      throw new Error('准备期间模型或任务控制已变化，消息未投递');
  };
  check();
  return {
    snapshot: () => { check(); return options.snapshot(); },
    compact: async (signal) => {
      check(); const snapshot = options.snapshot();
      if (!snapshot.modelIdle || !snapshot.remoteIdle || !options.agent?.compactIdle) throw new Error('会话或远端未空闲，不能整理上下文');
      const combined = AbortSignal.any([options.signal, signal]);
      await options.agent.compactIdle({ signal: combined, assertValid: () => {
        check(); if (!options.snapshot().remoteIdle) throw new Error('远端状态已变化，已停止整理');
      }, reserve: async (profile, attempt, requestSignal) => {
        check(); combined.throwIfAborted();
        if (attempt.purpose !== 'compaction' || !samePreparationModel(profile, expected)) throw new Error('压缩请求绑定已变化');
        const budget = await options.reserve(attempt, requestSignal);
        check(); combined.throwIfAborted();
        options.charged(profile, budget, attempt);
      } });
      check();
    }
  };
}

/** Synchronous final dispatch check, before intent changes or any prompt/steer. */
export function assertPreparedInput(snapshot: PreparationSnapshot, revision: string, text: string): void {
  if (snapshot.revision !== revision) throw new Error('发送准备版本已失效，消息未投递，请重新发送');
  if (estimateTextTokens(text) > snapshot.budget.availableInput) throw new Error('准备后可输入空间不足，请缩小引用范围或稍后发送');
}
