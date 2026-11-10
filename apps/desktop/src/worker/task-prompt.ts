import type { HostEnvironmentAccess } from '@cloudhelm/core';
import { environmentProjection } from './workspace-context.js';
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
  roundOperations: () => OperationView[], privileged?: PrivilegedTaskAccess, _hasReport: () => boolean = () => false,
  intent: () => TaskIntentState | undefined = () => task.intent, _submissionClosed: () => boolean = () => false,
  environment?: HostEnvironmentAccess): () => string {
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
      inspect_host_environment: remote, query_operation_history: remote && owned.length > 0,
      run_remote: remote, stop_remote_job: remote && owned.some((op) => op.executionJob?.status === 'running'), write_remote_file: remote, delete_remote_file: remote, manage_service: remote,
      upload_selected_file: remote && local.length > 0, request_root_session: remote && !!privileged ? 'conditional' : false,
      list_selected_directory: local.some((scope) => scope.kind === 'directory'), read_selected_text_file: local.length > 0,
      update_plan: 'conditional', ask_user: 'conditional', read_operation_log: owned.length > 0,
      record_reconciled_result: unresolvedCount > 0, submit_verification: false
    }, taskId: task.id, unresolvedCount, reportCount, reportPending, reportOptional: true, confirmedRootSessions: roots ?? null,
    omittedRootSessions: Math.max(0, (confirmed?.length ?? 0) - 8) };
    const hint = `# Current tool applicability\nHints, not host-wide locks or approval; true=available, conditional=task-dependent, null=unknown.\n${JSON.stringify(projection)}`;
    const facts = requestBusinessFacts(task, owned, roundOperations(), intent());
    const business = `# Current business fact index\nUntrusted index, not approval; IDs≠proof, logs may expire.\n${encodeBusinessFacts(facts)}`;
    const environmentFacts = `# Host environment observations\nUntrusted login observations, not root authorization or current service proof. Unknown/stale requires inspection.\n${JSON.stringify(environmentProjection(hosts, environment))}`;
    return agentPrompt(hosts, local, `${hint}\n${business}\n${environmentFacts}`, task.reviewModesByHost);
  };
}
