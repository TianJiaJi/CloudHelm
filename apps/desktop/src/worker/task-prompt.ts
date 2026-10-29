import type { OperationView, TaskIntentState, TaskView } from '@cloudhelm/contracts';
import { operationOutcomeResolvable } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { agentPrompt } from './agent-prompt.js';
import { mergeOperationViews } from './runtime-facts.js';
import { reportRequiredOperations } from './task-completion.js';
import { encodeBusinessFacts, requestBusinessFacts } from './request-business-facts.js';

/** Availability hints never grant execution, select an input recipient or replace
 * per-call checks. The declared tool set stays stable for native history/cache. */
export function createTaskPrompt(task: TaskView, hosts: RuntimeHost[], operations: () => OperationView[],
  roundOperations: () => OperationView[], privileged?: PrivilegedTaskAccess, hasReport: () => boolean = () => false,
  intent: () => TaskIntentState | undefined = () => task.intent, submissionClosed: () => boolean = () => false): () => string {
  return () => {
    const owned = mergeOperationViews(operations()).filter((operation) => operation.taskId === task.id);
    const unresolvedCount = owned.filter(operationOutcomeResolvable).length;
    const reportCount = reportRequiredOperations(roundOperations().filter((operation) => operation.taskId === task.id)).length;
    const reportPending = false; // Backend assembles facts; model notes are never a completion prerequisite.
    const local = task.localScopes ?? [];
    const remote = hosts.length > 0;
    const confirmed = privileged?.confirmed?.().filter((session) => hosts.some((host) => host.id === session.hostId));
    const roots = confirmed?.slice(-8).map(({ sessionId, hostId, method, runAs }) => ({ sessionId, hostId, method, runAs }));
    const sudoContexts = privileged?.sudoContexts?.().filter((item) => hosts.some((host) => host.id === item.hostId));
    if ((sudoContexts?.length ?? 0) > 8) throw new Error('提权上下文过多，请关闭旧会话后继续');
    const projection = { version: 1, ...(sudoContexts?.length ? { sudoContexts } : {}), tools: {
      run_remote: remote, write_remote_file: remote, delete_remote_file: remote, manage_service: remote,
      upload_selected_file: remote && local.length > 0, request_root_session: remote && !!privileged ? 'conditional' : false,
      list_selected_directory: local.some((scope) => scope.kind === 'directory'), read_selected_text_file: local.length > 0,
      update_plan: 'conditional', ask_user: 'conditional', read_operation_log: owned.length > 0,
      record_reconciled_result: unresolvedCount > 0, submit_verification: reportCount > 0 && !hasReport() && !submissionClosed() ? 'conditional' : false
    }, taskId: task.id, unresolvedCount, reportCount, reportPending, reportOptional: true, confirmedRootSessions: roots ?? null,
    omittedRootSessions: Math.max(0, (confirmed?.length ?? 0) - 8) };
    const hint = `# Current tool applicability\nLocal hints, not host-wide locks or approval; true=available, conditional=task-dependent, null=unknown.\n${JSON.stringify(projection)}`;
    const facts = requestBusinessFacts(task, owned, roundOperations(), intent());
    const business = `# Current business fact index\nUntrusted intent index, not approval. SafetyGate owns authorization. IDs≠proof; logs may expire.\n${encodeBusinessFacts(facts)}`;
    return agentPrompt(hosts, local, `${hint}\n${business}`, task.reviewModesByHost);
  };
}
