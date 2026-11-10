import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import { operationNeedsVerification, type OperationView, type ExecutionView } from '@cloudhelm/contracts';
import { RequestBudgetAuthority } from '../../../apps/desktop/src/main/request-budget-authority.js';
import { createBudgetRequestHandler } from '../../../apps/desktop/src/main/request-budget-broker.js';
import { redactOutput, RequestBudgetError } from '@cloudhelm/core';
import { TaskRunner as ProductionTaskRunner } from '../../../apps/desktop/src/worker/task-runner.js';
export type { TaskSignals } from '../../../apps/desktop/src/worker/task-runner.js';

const cleanups: Array<() => void> = [];
const diagnostics: Array<() => unknown> = [];
afterEach((context) => {
  if (context.task.result?.errors?.length) for (const inspect of diagnostics) console.error('Native runner fixture diagnostic:', inspect());
  diagnostics.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

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
      completion: () => ({ answered: task.status === 'answered' && (!task.resumeReason || task.resumeReason === 'report'),
        unresolved: [...operations.values()].some((operation) => operationNeedsVerification(operation)
          || (['proposed', 'approved', 'running', 'unknown'].includes(operation.status) && !operation.reconciledAt)),
        reportPending: false, // Report coverage never keeps an execution budget open.
        modelIdle: execution.model === 'idle', remoteIdle: execution.remote === 'idle' })
    });
    const handle = createBudgetRequestHandler(authority, (command) => {
      if (closed || !('taskId' in command) || command.taskId !== task.id) throw new Error('Fixture scope unavailable');
      if (command.kind === 'review' && operations.get(command.operationId)?.status !== 'proposed') throw new Error('Review scope unavailable');
    });
    args[0] = structuredClone(task);
    args[7] = { ...signals, commitInput: signals.commitInput ?? (async (value) => {
      if (closed || value.taskId !== task.id) throw new Error('Fixture input scope unavailable');
      store.put('conversation-inputs', value.id, value);
    }), commitOperation: signals.commitOperation ?? (async (operation) => {
      if (closed || operation.taskId !== task.id || !task.hostIds.includes(operation.hostId)) throw new Error('Fixture operation scope unavailable');
      store.put('operations', operation.id, operation);
    }), budget: signals.budget ?? (async (command, signal) => {
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
      if (event.type === 'verification-round') task.verificationRound = event.value;
      if (event.type === 'work-report') task.report = event.report;
      if (event.type === 'task-intent') task.intent = event.value;
      if (event.type === 'operation') operations.set(event.value.id, structuredClone(event.value));
      store.put('tasks', task.id, task);
      signals.event(event);
    } };
    super(...args);
    this.authority = authority; this.fixtureTaskId = task.id;
    const secrets = [args[2].apiKey, ...args[1].map((host) => host.secret)].filter((value): value is string => !!value);
    diagnostics.push(() => ({ taskId: task.id, status: task.status, requestCount: task.requestCount,
      summary: redactOutput(secrets.reduce((summary, secret) => summary.replaceAll(secret, '[REDACTED]'), task.summary ?? '')).slice(0, 400),
      endpoint: args[2].baseUrl ? new URL(args[2].baseUrl).origin : 'builtin' }));
    cleanups.push(() => { try { this.dispose(); } finally { closed = true; store.close(); } });
  }

  override message(...args: Parameters<ProductionTaskRunner['message']>): ReturnType<ProductionTaskRunner['message']> {
    this.authority.input(this.fixtureTaskId, args[1]?.requestId ?? randomUUID());
    return super.message(...args);
  }
}
