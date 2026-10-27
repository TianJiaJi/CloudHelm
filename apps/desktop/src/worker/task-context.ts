import type { ConversationSession } from '@cloudhelm/core';
import type { LocalScope, OperationView, TaskIntentState, TaskView, UserInterruption } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import type { PreparationSnapshot } from './task-preparation.js';
import { createTaskPrompt } from './task-prompt.js';
import { recoveryContextMessage } from './recovery-context.js';
import { interruptionContext } from './task-input-context.js';
import { NEXT_INPUT_FACT_TOKENS, withInputFactReserve } from './request-business-facts.js';

export function taskContextSnapshot(options: {
  agent?: ConversationSession; task: TaskView; hosts: RuntimeHost[]; scopes: LocalScope[];
  operations: OperationView[]; round: OperationView[]; intent: TaskIntentState; pendingIntent?: TaskIntentState; privileged?: PrivilegedTaskAccess;
  hasReport: boolean; needsRecovery: boolean; interruption?: UserInterruption; modelIdle: boolean; remoteIdle: boolean;
}): PreparationSnapshot {
  if (!options.agent?.contextSnapshot) throw new Error('对话上下文尚未就绪');
  const prompt = createTaskPrompt({ ...options.task, localScopes: [...options.task.localScopes, ...options.scopes] }, options.hosts,
    () => options.operations, () => options.round, options.privileged, () => options.hasReport, () => options.pendingIntent ?? options.intent)();
  const pending = [options.needsRecovery ? recoveryContextMessage(options.operations) : '',
    interruptionContext(options.interruption, options.operations)].filter(Boolean);
  const frame = pending.length ? `${prompt}\n${pending.join('\n')}\n${' '.repeat(256)}` : prompt;
  const snapshot = options.agent.contextSnapshot(options.pendingIntent ? frame : withInputFactReserve(frame));
  return { ...snapshot, budget: { ...snapshot.budget, pendingInputReserve: options.pendingIntent ? 0 : NEXT_INPUT_FACT_TOKENS }, modelIdle: options.modelIdle, remoteIdle: options.remoteIdle };
}
