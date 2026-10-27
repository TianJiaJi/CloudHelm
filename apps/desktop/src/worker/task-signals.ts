import type { DiagnosticEvent } from '@cloudhelm/core';
import type { AppEvent, ApprovalView, BudgetCommand, BudgetValue, OperationView, ResumeReason, TaskStatus } from '@cloudhelm/contracts';

export interface TaskSignals {
  budget?(command: BudgetCommand, signal?: AbortSignal): Promise<BudgetValue>;
  clearCredentials?(): void;
  diagnostic?(event: DiagnosticEvent): void;
  event(event: AppEvent | { type: 'approval-open'; value: ApprovalView } | { type: 'approval-close'; id: string }
    | { type: 'operation'; value: OperationView } | { type: 'task-status'; taskId: string; status: TaskStatus; summary?: string; resumeReason?: ResumeReason; requestCount?: number }): void;
  requestApproval(view: ApprovalView): Promise<boolean>;
  cancelApproval(id: string): void;
}
