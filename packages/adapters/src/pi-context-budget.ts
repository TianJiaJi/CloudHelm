import { createHash } from 'node:crypto';
import { contextBudget, estimateTextTokens, type SessionContextSnapshot, type SessionProfile } from '@cloudhelm/core';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { resolveSessionModel } from './pi-session-model.js';

/** Only the active native projection is measured. The JSONL archive stays intact. */
export function sessionContextSnapshot(session: AgentSession, profile: SessionProfile, originalPrompt: string,
  currentPrompt: string, useUsage: boolean, previousFrameTokens: number | undefined, generation: string): SessionContextSnapshot & { frameTokens: number } {
  const system = session.systemPrompt.includes(originalPrompt) ? session.systemPrompt.replace(originalPrompt, currentPrompt)
    : `${session.systemPrompt}\n${currentPrompt}`;
  const frame = JSON.stringify([system, session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))]);
  // agent.state.messages is runtime/transcript state, not the canonical
  // compaction-aware input. The public projection also applies context edits.
  const messages = session.sessionManager.buildSessionProjection().messages.filter((message) => message.role !== 'system');
  const history = JSON.stringify(messages);
  const frameTokens = estimateTextTokens(frame);
  const model = resolveSessionModel(profile).model;
  const last = messages.at(-1);
  const provider = useUsage && last?.role === 'assistant' && !['error', 'aborted', 'length'].includes(last.stopReason)
    && last.provider === profile.provider && last.model === profile.modelId
    && last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite > 0;
  const usage = provider ? session.getContextUsage()?.tokens : undefined;
  const revision = createHash('sha256').update(JSON.stringify([generation, profile.provider, profile.modelId,
    profile.credentialRevision, model.contextWindow, model.maxTokens, frame, history])).digest('hex');
  return { revision, frameTokens, historyTokens: estimateTextTokens(history), hasHistory: messages.some((message) => ['user', 'assistant', 'compactionSummary'].includes(message.role)),
    budget: contextBudget({ contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
      historyTokens: estimateTextTokens(history), frameTokens, providerUsedTokens: usage ?? undefined, previousFrameTokens }) };
}
