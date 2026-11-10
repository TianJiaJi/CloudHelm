import { jobNeedsAttention } from './execution-workspace-view.js';
import { operationNeedsVerification, type ExecutionView, type TaskStatus } from '@cloudhelm/contracts';
import type { TimelineEntry } from './conversation-timeline.js';

type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;
export interface ConversationTurn {
  key: string;
  input?: MessageEntry;
  entries: TimelineEntry[];
  answer?: MessageEntry;
  foldable: boolean;
  operationCount: number;
  messageCount: number;
  riskCount: number;
  latest: boolean;
}

/** Visual grouping only. Never changes backend execution, approval, or recovery
 * state. Incomplete/uncertain work stays expanded even if the model says done. */
export function conversationTurns(entries: TimelineEntry[], current: {
  status: TaskStatus; execution?: ExecutionView; pendingInteraction: boolean; liveReasoning: boolean;
}): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let turn: ConversationTurn | undefined;
  for (const entry of entries) {
    const input = entry.kind === 'message' && entry.value.role === 'user' && entry.value.source !== 'clarification';
    if (!turn || input) {
      turn = { key: input ? entry.key : 'earlier-context', entries: [], foldable: false,
        operationCount: 0, messageCount: 0, riskCount: 0, latest: false };
      turns.push(turn);
    }
    if (input) turn.input = entry as MessageEntry;
    else turn.entries.push(entry);
  }
  for (const [index, group] of turns.entries()) {
    group.latest = index === turns.length - 1;
    const operations = group.entries.filter((entry) => entry.kind === 'operation').map((entry) => entry.value);
    group.operationCount = operations.length;
    group.riskCount = operations.filter((operation) => operation.reconciliation?.kind === 'risk-accepted').length;
    // A final text must follow the operations, not be an earlier progress message.
    const last = group.entries.at(-1);
    const answer = last?.kind === 'message' && last.value.role === 'agent' && last.value.text.trim() ? last : undefined;
    const unfinished = operations.some((operation) => operationNeedsVerification(operation) || jobNeedsAttention(operation) || operation.status === 'failed'
      || ['proposed', 'approved', 'running'].includes(operation.status)
      || operation.status === 'unknown' && !operation.reconciledAt);
    const waiting = group.entries.some((entry) => entry.kind === 'clarification' && entry.value.status === 'pending');
    const currentSettled = current.status === 'answered' && !current.pendingInteraction && !current.liveReasoning
      && (!current.execution || current.execution.model === 'idle' && current.execution.remote === 'idle'
        && !current.execution.stopping && !current.execution.canStop);
    group.foldable = !!answer && !unfinished && !waiting && (!group.latest || currentSettled)
      && operations.every((operation) => (operation.completedAt ?? operation.createdAt) <= answer.value.createdAt);
    if (group.foldable) group.answer = answer;
    group.messageCount = group.entries.filter((entry) => entry.kind === 'message' && entry.key !== group.answer?.key
      && (entry.value.text.trim() || entry.value.reasoning?.text.trim())).length;
  }
  return turns;
}
