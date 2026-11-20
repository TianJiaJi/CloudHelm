import { redactOutput, type ApprovalRequester } from '@cloudhelm/core';
import type { ApprovalView } from '@cloudhelm/contracts';
import { approvalPresentation } from './approval-presentation.js';
import type { TaskSignals } from './task-signals.js';

type ApprovalOperation = Parameters<ApprovalRequester['requestApproval']>[0]['operation'];

/** Projection and wait lifecycle only; the gate/worker retain approval authority. */
export function createTaskApprovals(signals: Pick<TaskSignals, 'requestApproval' | 'cancelApproval' | 'extendApproval'>,
  preview: (operation: ApprovalOperation) => string, waiting: () => void, settled: () => void): ApprovalRequester {
  const extendApproval = signals.extendApproval;
  return {
    requestApproval: async (request) => {
      waiting();
      const presentation = approvalPresentation(request);
      const view: ApprovalView = {
        id: request.id, taskId: request.operation.scope.taskId, operationId: request.operation.id,
        hostId: request.operation.scope.hostId, fingerprint: request.fingerprint, title: presentation.title,
        explanation: request.operation.kind === 'command' && request.operation.executionMode === 'background'
          ? `后台执行：AI 回答结束不会终止进程；停止须另行操作。${presentation.explanation}` : presentation.explanation,
        preview: preview(request.operation), account: request.operation.scope.runAs,
        cwd: request.operation.scope.cwd, impact: request.impact,
        targets: request.targets?.map((target) => redactOutput(target)),
        recovery: presentation.recovery,
        expiresAt: request.expiresAt,
        hardExpiresAt: request.hardExpiresAt
      };
      try { return await signals.requestApproval(view); }
      finally { settled(); }
    },
    cancelApproval: (id) => signals.cancelApproval(id),
    extendApproval: extendApproval ? (id, extendMs) => extendApproval(id, extendMs) : undefined
  };
}
