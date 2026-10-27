import { isEffectFreeQuery, operationIntentKey, redactOutput, type CommandAnalyzer, type ProposedOperation } from '@cloudhelm/core';
import { operationNeedsVerification, type HostView, type OperationView, type TaskView } from '@cloudhelm/contracts';

export const HISTORICAL_QUERY_REPAIR = { name: 'completed-query-capability', version: 1 } as const;
export interface HistoricalState {
  operations: OperationView[];
  tasks: TaskView[];
  hosts: HostView[];
}

/** A preview is not source evidence. The existing fingerprint must match the
 * entire command plus its recorded host, login identity, execution identity and
 * directory. Candidate legacy directories grant nothing without that match. */
function completeCommand(operation: OperationView, task: TaskView | undefined, host: HostView | undefined): boolean {
  if (!task || !host || !task.hostIds.includes(host.id) || !operation.runAs || !operation.loginAs
    || operation.loginAs !== host.username || !/^[a-f0-9]{64}$/u.test(operation.intentKey ?? '')
    || !operation.preview || operation.preview.includes('[REDACTED]')
    || redactOutput(operation.preview) !== operation.preview) return false;
  const source = operation.commandSource;
  if (source && (source.version !== 1 || typeof source.cwd !== 'string' || !source.cwd.startsWith('/'))) return false;
  // Older records omitted cwd. Only check these finite conventional directories;
  // a custom home/cwd that cannot be reconstructed stays unchanged. No SSH, logs,
  // model transcript or current filesystem data is consulted to guess a match.
  const directories = source ? [source.cwd] : ['/', '/root', `/home/${host.username}`, '/srv', '/opt'];
  return directories.some((cwd) => {
    const proposed: ProposedOperation = { id: operation.id, kind: 'command', command: operation.preview, scope: {
      taskId: operation.taskId, hostId: operation.hostId, cwd, runAs: operation.runAs!, loginAs: operation.loginAs,
      terminalId: '', terminalGeneration: 0, policyRevision: 0, goal: '', allowedWorkingRoots: [], protectedPaths: []
    } };
    return operationIntentKey(proposed) === operation.intentKey;
  });
}

function repairTask(task: TaskView, operations: OperationView[], repaired: Set<string>): TaskView | undefined {
  const state = task.verificationState;
  if (state?.status !== 'unverified' || state.reasonCode !== 'report-missing'
    || !state.operationIds.some((id) => repaired.has(id))) return undefined;
  const changes = operations.filter((op) => op.status === 'succeeded' && op.readOnly !== true);
  // Old incomplete ID lists must not lose actual changes on the next restart.
  // Without a provable historical round boundary, retain their evidence need.
  const remaining = [...new Set([...state.operationIds.filter((id) => !repaired.has(id)), ...changes.map((op) => op.id)])];
  const updated = { ...task, verificationState: { ...state, operationIds: remaining } };
  // No prose-based completion inference, no reassessment of legacy reports, and
  // no release of a pending report if a write/unknown outcome was omitted from
  // an old report's ID list. Preserve interruption/model/authentication stops.
  const uncertain = operations.some(operationNeedsVerification);
  if (!remaining.length && !uncertain && !changes.length && !task.report
    && task.status === 'answered' && task.resumeReason === 'report') {
    const completed: TaskView = { ...updated };
    delete completed.verificationState;
    delete completed.resumeReason;
    delete completed.summary;
    return completed;
  }
  return updated;
}

/** Produces data-only patches. The caller commits all patches and per-record
 * version receipts together before restoring any host locks. */
export async function planHistoricalQueryRepair(state: HistoricalState, analyzer: CommandAnalyzer): Promise<{
  operations: OperationView[]; tasks: TaskView[];
}> {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const hosts = new Map(state.hosts.map((host) => [host.id, host]));
  const changed = new Map<string, OperationView>();
  for (const operation of state.operations) {
    if (operation.kind !== 'command' || (operation.readOnly === true && operation.effects === 'none')
      || !['succeeded', 'failed'].includes(operation.status) || !Number.isSafeInteger(operation.exitCode)
      || operation.exitCode! < 0 || operation.exitCode! > 255
      || !completeCommand(operation, tasks.get(operation.taskId), hosts.get(operation.hostId))) continue;
    try {
      const analysis = await analyzer.analyze(operation.preview);
      if (analysis.raw !== operation.preview || !isEffectFreeQuery(analysis)) continue;
    } catch { continue; } // No completion receipt: a missing parser is retryable on restart.
    // Execution, acceptance, evidence, interruption and audit metadata stay exact.
    changed.set(operation.id, { ...operation, readOnly: true, effects: 'none' });
  }
  const repaired = new Set(changed.keys());
  const operations = state.operations.map((op) => changed.get(op.id) ?? op);
  const taskChanges: TaskView[] = [];
  for (const task of state.tasks) {
    const owned = operations.filter((op) => op.taskId === task.id);
    const updated = repairTask(task, owned, new Set(owned.filter((op) => repaired.has(op.id)).map((op) => op.id)));
    if (updated) taskChanges.push(updated);
  }
  return { operations: [...changed.values()], tasks: taskChanges };
}
