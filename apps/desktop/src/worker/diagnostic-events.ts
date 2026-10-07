import { safeDiagnostic } from '@cloudhelm/core';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';

/** Project known event fields, never serialize an entire event or authentication prompt. */
export function eventDiagnostic(message: RuntimeMessage) {
  if (!('event' in message)) return;
  const event = message.event;
  switch (event.type) {
    case 'task-message': return safeDiagnostic({ event: 'chat', level: 'info', taskId: event.taskId, role: event.role, text: event.text });
    case 'model-request': return safeDiagnostic({ event: 'model.request', taskId: event.taskId,
      provider: event.model.provider, model: event.model.modelId, request: event.request });
    case 'task-status': return safeDiagnostic({ event: 'task.status', level: event.status === 'failed' ? 'error' : 'info',
      taskId: event.taskId, status: event.status, text: event.summary });
    case 'operation': return safeDiagnostic({ event: 'operation', taskId: event.value.taskId, hostId: event.value.hostId,
      operationId: event.value.id, runAs: event.value.runAs, loginAs: event.value.loginAs, status: event.value.status, exitCode: event.value.exitCode,
      command: event.value.kind === 'command' ? event.value.preview : undefined,
      text: event.value.kind === 'command' ? event.value.outputTail : undefined,
      authentication: event.value.authentication, authenticationAttempts: event.value.authenticationAttempts, failureKind: event.value.failureKind, effects: event.value.effects });
    case 'input-open': return safeDiagnostic({ event: 'authentication.open', taskId: event.value.taskId,
      hostId: event.value.hostId, operationId: event.value.operationId, requestId: event.value.id, status: event.value.kind });
    case 'input-close': return safeDiagnostic({ event: 'authentication.close', requestId: event.id });
    case 'host-status': return safeDiagnostic({ event: 'host.status', hostId: event.hostId, status: event.status });
    case 'terminal-state': return safeDiagnostic({ event: 'terminal.state', hostId: event.hostId, taskId: event.taskId, status: event.state });
  }
}
