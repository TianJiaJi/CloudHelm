import type { ContextBudget, DiagnosticEvent, SessionEvent } from '@cloudhelm/core';
import type { TaskSignals } from './task-signals.js';
import { taskToolDiagnostic } from './task-tool-diagnostic.js';

/** Translate native notifications; this module cannot authorize or start work. */
export function taskSessionEvents(taskId: string, hooks: {
  event: TaskSignals['event']; request(): { count: number; started: number }; usageBudget?(): ContextBudget | undefined;
  activity(): void; compactionFailed(error?: string): void;
  diagnostic(event: DiagnosticEvent): void; turnEnd(): void;
}): (event: SessionEvent) => void {
  let lastResponse: string | undefined;
  return (event) => {
    if (event.type === 'reasoning-progress') hooks.event({ type: 'reasoning-progress', taskId, value: event.value });
    if (event.type === 'thinking') hooks.event({ type: 'thinking', taskId, value: event.value });
    if (event.type === 'activity') hooks.activity();
    if (event.type === 'text') hooks.event({ type: 'task-message', taskId, ...event.value });
    if (event.type === 'usage') hooks.event({ type: 'context-usage', taskId, value: { ...event.value, budget: hooks.usageBudget?.() ?? event.value.budget, request: hooks.request().count } });
    if (event.type === 'compaction') {
      hooks.event({ type: 'context-compaction', taskId, status: event.status });
      if (event.status === 'failed') hooks.compactionFailed(event.error);
    }
    if (event.type === 'tool-start' || event.type === 'tool-end') hooks.diagnostic(taskToolDiagnostic(event));
    if (event.type === 'response') {
      const request = hooks.request(); const attempt = event.attempt;
      if (!attempt) { hooks.diagnostic({ event: 'model.response-unattributed', responseAttributed: false }); return; }
      const key = `${attempt.logicalRequestId}/${attempt.attempt}`;
      if (key === lastResponse) return;
      lastResponse = key;
      hooks.diagnostic({ event: 'model.response', request: request.count, logicalRequestId: attempt.logicalRequestId,
        purpose: attempt.purpose, attempt: attempt.attempt, transport: attempt.transport, status: event.status,
        responseAttributed: true, durationMs: Date.now() - request.started });
    }
    if (event.type === 'turn-end') hooks.turnEnd();
  };
}
