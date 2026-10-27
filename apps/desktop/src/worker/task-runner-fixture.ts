import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import { operationNeedsVerification, type OperationView, type ExecutionView } from '@cloudhelm/contracts';
import { RequestBudgetAuthority } from '../main/request-budget-authority.js';
import { createBudgetRequestHandler } from '../main/request-budget-broker.js';
import { RequestBudgetError } from '@cloudhelm/core';
import { TaskRunner as ProductionTaskRunner } from './task-runner.js';
export type { TaskSignals } from './task-runner.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** Local integration fixture: simulates Main's genuine-input boundary and uses
 * actual SQLite reservations. Not a production fallback or a model/SSH client. */
export class TaskRunner extends ProductionTaskRunner {
  private readonly authority: RequestBudgetAuthority;
  private readonly fixtureTaskId: string;
  constructor(...args: ConstructorParameters<typeof ProductionTaskRunner>) {
    const task = args[0]; const signals = args[7]; const store = new SqliteStore(':memory:');
    let closed = false;
    let execution: ExecutionView = { model: 'idle', remote: 'idle', stopping: false, canStop: false };
    const operations = new Map<string, OperationView>((args[3] ?? []).map((operation) => [operation.id, operation]));
    store.put('tasks', task.id, task);
    const authority = new RequestBudgetAuthority(store, {
      task: (id) => { if (id !== task.id) throw new Error('Foreign fixture task'); return task; },
      replace: (next) => Object.assign(task, structuredClone(next)),
      completion: () => ({ answered: task.status === 'answered' && !task.resumeReason,
        unresolved: [...operations.values()].some((operation) => operationNeedsVerification(operation)
          || (['proposed', 'approved', 'running', 'unknown'].includes(operation.status) && !operation.reconciledAt)),
        reportPending: task.resumeReason === 'report' || (task.verificationState?.status === 'unverified' && !task.report),
        modelIdle: execution.model === 'idle', remoteIdle: execution.remote === 'idle' })
    });
    const handle = createBudgetRequestHandler(authority, (command) => {
      if (closed || !('taskId' in command) || command.taskId !== task.id) throw new Error('Fixture scope unavailable');
      if (command.kind === 'review' && operations.get(command.operationId)?.status !== 'proposed') throw new Error('Review scope unavailable');
    });
    args[0] = structuredClone(task);
    args[7] = { ...signals, budget: signals.budget ?? (async (command, signal) => {
      signal?.throwIfAborted();
      const result = handle(command);
      if ('error' in result) {
        if (result.error === undefined || result.error === 'budget-unavailable') throw new Error('Fixture budget unavailable');
        throw new RequestBudgetError(result.error);
      }
      signal?.throwIfAborted(); return result.value;
    }), event: (event) => {
      if (closed) return;
      if (event.type === 'task-status') Object.assign(task, { status: event.status, resumeReason: event.resumeReason, summary: event.summary });
      if (event.type === 'execution') execution = event.value;
      if (event.type === 'verification-state') task.verificationState = event.value;
      if (event.type === 'work-report') task.report = event.report;
      if (event.type === 'task-intent') task.intent = event.value;
      if (event.type === 'operation') operations.set(event.value.id, structuredClone(event.value));
      store.put('tasks', task.id, task);
      signals.event(event);
    } };
    super(...args);
    this.authority = authority; this.fixtureTaskId = task.id;
    cleanups.push(() => { try { this.dispose(); } finally { closed = true; store.close(); } });
  }

  override message(...args: Parameters<ProductionTaskRunner['message']>): void {
    this.authority.input(this.fixtureTaskId, args[1]?.requestId ?? randomUUID());
    super.message(...args);
  }
}
