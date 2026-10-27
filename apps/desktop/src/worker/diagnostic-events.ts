import { safeDiagnostic } from '@cloudhelm/core';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';
import type { BudgetCommand, BudgetValue } from '@cloudhelm/contracts';

/** A durable reservation receipt, not a second HTTP dispatch or a billing claim. */
export function reservationDiagnostic(command: BudgetCommand, value: BudgetValue) {
  if (command.kind === 'current' || value.kind === 'current' || command.kind !== value.kind) return;
  return safeDiagnostic({ event: 'model.reservation', taskId: 'taskId' in command ? command.taskId : undefined,
    operationId: command.kind === 'review' ? command.operationId : undefined,
    requestId: command.kind === 'summary' ? command.requestId : undefined,
    logicalRequestId: command.attempt.logicalRequestId, purpose: command.attempt.purpose,
    attempt: command.attempt.attempt, transport: command.attempt.transport,
    roundId: value.kind === 'reserve' ? value.budget.roundId : undefined,
    request: value.kind === 'reserve' ? value.budget.totalUsed : value.used,
    status: value.kind === 'reserve' && value.duplicate ? 'duplicate-receipt' : 'reserved' });
}

/** Project known event fields, never serialize an entire event or authentication prompt. */
export function eventDiagnostic(message: RuntimeMessage) {
  if (!('event' in message)) return;
  const event = message.event;
  switch (event.type) {
    case 'task-message': return safeDiagnostic({ event: 'chat', level: 'info', taskId: event.taskId, role: event.role, size: Buffer.byteLength(event.text) });
    case 'model-request': return safeDiagnostic({ event: 'model.request', taskId: event.taskId,
      provider: event.model.provider, model: event.model.modelId, request: event.request, purpose: event.purpose,
      logicalRequestId: event.logicalRequestId, attempt: event.attempt, transport: event.transport, roundId: event.roundId });
    case 'task-status': return safeDiagnostic({ event: 'task.status', level: event.status === 'failed' ? 'error' : 'info',
      taskId: event.taskId, status: event.status, resumeReason: event.resumeReason,
      errorCode: event.status === 'failed' ? 'model-incomplete' : event.resumeReason === 'budget-exhausted' ? 'budget-exhausted' : undefined });
    case 'operation': return safeDiagnostic({ event: 'operation', taskId: event.value.taskId, hostId: event.value.hostId,
      operationId: event.value.id, runAs: event.value.runAs, loginAs: event.value.loginAs, status: event.value.status, exitCode: event.value.exitCode,
      readOnly: event.value.readOnly, classification: event.value.readOnly === true ? 'effect-free' : 'unclassified',
      reconciliationKind: event.value.reconciliation?.kind,
      evidenceOperationIds: event.value.reconciliation?.evidenceOperationIds,
      authentication: event.value.authentication, authenticationAttempts: event.value.authenticationAttempts, failureKind: event.value.failureKind, effects: event.value.effects });
    case 'input-open': return safeDiagnostic({ event: 'authentication.open', taskId: event.value.taskId,
      hostId: event.value.hostId, operationId: event.value.operationId, requestId: event.value.id, status: event.value.kind });
    case 'input-close': return safeDiagnostic({ event: 'authentication.close', requestId: event.id });
    case 'host-status': return safeDiagnostic({ event: 'host.status', hostId: event.hostId, status: event.status });
    case 'terminal-state': return safeDiagnostic({ event: 'terminal.state', hostId: event.hostId, taskId: event.taskId, status: event.state });
  }
}
