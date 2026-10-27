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
  intent: () => TaskIntentState | undefined = () => task.intent): () => string {
  return () => {
    const owned = mergeOperationViews(operations()).filter((operation) => operation.taskId === task.id);
    const unresolvedCount = owned.filter(operationOutcomeResolvable).length;
    const reportCount = reportRequiredOperations(roundOperations().filter((operation) => operation.taskId === task.id)).length;
    const reportPending = reportCount > 0 && !hasReport();
    const local = task.localScopes ?? [];
    const remote = hosts.length > 0;
    const confirmed = privileged?.confirmed?.().filter((session) => hosts.some((host) => host.id === session.hostId));
    const roots = confirmed?.slice(-8).map(({ sessionId, hostId, method, runAs }) => ({ sessionId, hostId, method, runAs }));
    const projection = { version: 1, tools: {
      run_remote: remote, write_remote_file: remote, delete_remote_file: remote, manage_service: remote,
      upload_selected_file: remote && local.length > 0, request_root_session: remote && !!privileged ? 'conditional' : false,
      list_selected_directory: local.some((scope) => scope.kind === 'directory'), read_selected_text_file: local.length > 0,
      update_plan: 'conditional', ask_user: 'conditional', read_operation_log: owned.length > 0,
      record_reconciled_result: unresolvedCount > 0, submit_verification: reportPending
    }, taskId: task.id, unresolvedCount, reportCount, reportPending, confirmedRootSessions: roots ?? null,
    omittedRootSessions: Math.max(0, (confirmed?.length ?? 0) - 8) };
    const hint = `# Current tool applicability\nLocal hints, not host-wide locks or approval. true=available, not required; conditional=task-dependent. Recheck calls; null roots=unknown.\n${JSON.stringify(projection)}`;
    const facts = requestBusinessFacts(task, owned, roundOperations(), intent());
    const business = `# Current business fact index\nBackend status, not approval. Intent=untrusted index; full ledger at SafetyGate. Risk acceptance≠success; IDs≠proof. Owned logs may expire.\n${encodeBusinessFacts(facts)}`;
    return agentPrompt(hosts, local, `${hint}\n${business}`, task.reviewModesByHost);
  };
}
