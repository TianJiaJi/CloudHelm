import { randomUUID } from 'node:crypto';
import type { ConversationSession, OperationScope, ProposedOperation } from '@cloudhelm/core';
import type { ConversationTerminalPool, TerminalManager } from '@cloudhelm/application';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { TaskSignals } from './task-signals.js';

export async function reviewDeniedOperation(operationId: string, deps: {
  task: TaskView; hosts: RuntimeHost[]; agent?: ConversationSession; terminal: TerminalManager; pool: ConversationTerminalPool;
  operations: Map<string, OperationView>; denied: Map<string, ProposedOperation>; inFlight: Set<string>;
  version(): number; blocked(): boolean; reviewerRevision(): number;
  scope(host: RuntimeHost, terminalId: string, cwd: string): OperationScope;
  event: TaskSignals['event']; start(): void; finish(): void;
  execute(operation: ProposedOperation, label: string): Promise<unknown>;
}): Promise<void> {
  const operation = deps.denied.get(operationId);
  if (!operation || !deps.operations.get(operationId)?.manualReviewAvailable) throw new Error('该操作已过期或不可复核');
  if (deps.inFlight.has(operationId)) throw new Error('该操作正在人工复核');
  deps.inFlight.add(operationId);
  const version = deps.version();
  try {
    await deps.agent?.waitForIdle();
    if (version !== deps.version()) throw new Error('对话控制状态已变化，请重新提出操作');
    if (deps.blocked() || deps.terminal.pendingOperations(deps.task.id).length) throw new Error('远端状态未确定，请先核验后继续');
    if (!deps.operations.get(operationId)?.manualReviewAvailable) throw new Error('该操作已过期或不可复核');
    const host = deps.hosts.find((candidate) => candidate.id === operation.scope.hostId);
    if (!host || host.username !== (operation.scope.loginAs ?? operation.scope.runAs)
      || host.policyRevision !== operation.scope.policyRevision
      || (deps.task.reviewRevision ?? 1) !== (operation.scope.conversationRevision ?? 1)
      || deps.reviewerRevision() !== (operation.scope.reviewerRevision ?? 1)) {
      throw new Error('主机身份或审核策略已变化，请重新提出操作');
    }
    let terminalId = operation.scope.terminalId;
    if (!deps.terminal.isAgentOwner(terminalId)) {
      if (operation.scope.sessionId) throw new Error('特权会话已失效，请重新建立后提出操作');
      terminalId = await deps.pool.acquire(host.id, () => {
        if (version !== deps.version()) throw new Error('对话控制状态已变化，复核未开始');
      });
      if (!deps.terminal.isAgentOwner(terminalId)) throw new Error('新终端未交给 AI，复核未开始');
      deps.event({ type: 'terminal-replaced', previousTerminalId: operation.scope.terminalId, terminalId });
    }
    const reviewed: ProposedOperation = { ...operation, id: randomUUID(), scope: {
      ...deps.scope(host, terminalId, operation.scope.cwd), runAs: operation.scope.runAs,
      goal: operation.scope.goal, intent: operation.scope.intent
    } };
    const view = deps.operations.get(operationId)!;
    view.manualReviewAvailable = false; deps.denied.delete(operationId);
    deps.event({ type: 'operation', value: view }); deps.start();
    try { await deps.execute(reviewed, host.label); } finally { deps.finish(); }
  } finally { deps.inFlight.delete(operationId); }
}
