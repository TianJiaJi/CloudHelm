import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '@cloudhelm/adapters';
import type { RuntimeHost, RuntimeMessage, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import type { TaskView } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { WorkerServer } from '../../../apps/desktop/src/worker/server.js';
import type { TaskRunner } from '../../../apps/desktop/src/worker/task-runner.js';

/** In-process production WorkerServer + Main authority + file SQLite.
 * Only the transport/model endpoints are supplied by each test. Not a real
 * utilityProcess crash test, and not a fake implementation of the safety lock. */
export async function securityWorker(host: RuntimeHost, options: { autoRejectApproval?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-worker-security-'));
  const file = path.join(root, 'audit.sqlite');
  const store = new SqliteStore(file);
  store.put('hosts', host.id, host);
  store.put('settings', 'model-profile', { provider: 'cloudhelm-custom', modelId: 'fixture' });
  const state = new AppState(store, () => {});
  const messages: RuntimeMessage[] = [];
  let accepting = true;
  const workers: WorkerServer[] = [];
  function createWorker(): WorkerServer {
    const server = new WorkerServer((message) => {
      if (!accepting) return;
      messages.push(structuredClone(message));
      if ('event' in message) state.record(message.event);
      if ('budgetRequest' in message) server.resolveBudget({ id: message.budgetRequest.id,
        ...state.requestBudget(message.budgetRequest.command) });
      if ('commitOperation' in message) {
        let committed = false;
        try { state.commitOperation(message.commitOperation.value); committed = true; } catch { /* explicit negative ack */ }
        server.resolveOperationCommit({ id: message.commitOperation.id, taskId: message.commitOperation.value.taskId,
          operationId: message.commitOperation.value.id, committed });
      }
      if ('commitInput' in message) server.resolveInputCommit({ id: message.commitInput.id,
        taskId: message.commitInput.value.taskId, inputId: message.commitInput.value.id, committed: false });
      if ('readLog' in message) server.resolveLog({ id: message.readLog.id, value: { text: '', nextCursor: 0, more: false } });
      if ('event' in message && message.event.type === 'approval-open' && options.autoRejectApproval !== false) {
        const approvalId = message.event.value.id;
        // Real IPC replies are asynchronous, not reentrant within post(). Do not
        // hide dispatch errors: an invalid recipient must still fail the test.
        void Promise.resolve().then(() => server.dispatch({ method: 'decide-approval', approvalId, approved: false }));
      }
    });
    workers.push(server); return server;
  }
  const server = createWorker();
  function task(goal: string): TaskView {
    const value = state.createTask(goal, [host.id], 'fixture', []);
    state.requestBudgets.input(value.id, `start-${value.id}`);
    return state.getTask(value.id);
  }
  async function start(value: TaskView, profile: RuntimeProfile, worker = server) {
    await worker.dispatch({ method: 'start-task', task: value, hosts: [structuredClone(host)], profile,
      sessionDirectory: path.join(root, 'sessions', value.id) });
  }
  async function close() {
    accepting = false;
    for (const worker of workers) {
      const runners = (worker as unknown as { tasks: Map<string, TaskRunner> }).tasks;
      for (const runner of runners.values()) { await runner.close(); }
    }
    state.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
  return { server, createWorker, root, file, store, state, messages, task, start, close };
}
