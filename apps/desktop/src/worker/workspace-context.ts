import { HOST_ENVIRONMENT_MAX_AGE_MS, redactOutput, type HostEnvironmentAccess, type HostEnvironmentObservation, type BusinessTool } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { Type, type Static } from 'typebox';
import { mergeOperationViews } from './runtime-facts.js';

export function hostEnvironmentSnapshot(host: RuntimeHost, access?: HostEnvironmentAccess): HostEnvironmentObservation {
  return access?.snapshot(host.id, host.username) ?? {
    version: 1, hostId: host.id, loginAs: host.username, connectionId: null, observedAt: null, status: 'unknown', reason: 'not-observed',
    readiness: { ssh: 'disconnected', metadata: 'unknown', execution: 'unknown' }
  };
}
export function environmentProjection(hosts: RuntimeHost[], access?: HostEnvironmentAccess, now = Date.now()) {
  return hosts.map((host) => {
    const snapshot = hostEnvironmentSnapshot(host, access);
    const fresh = snapshot.status === 'observed' && snapshot.observedAt !== null
      && now >= snapshot.observedAt && now - snapshot.observedAt < HOST_ENVIRONMENT_MAX_AGE_MS;
    // Readiness is an operator-facing fact (SSH/metadata/exec channel); the model
    // context stays lean and never treats "connected" as permission to run anything.
    const { version: _version, reason: _reason, readiness: _readiness, ...publicSnapshot } = snapshot;
    return { ...publicSnapshot, freshness: fresh ? 'recent-observation' : 'unknown-or-stale' };
  });
}

const historyParameters = Type.Object({
  hostId: Type.String({ minLength: 1, maxLength: 128 }),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  beforeOperationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
}, { additionalProperties: false });
type HistoryQuery = Static<typeof historyParameters>;

/** Searches the durable operation ledger, not the model's compacted transcript.
 * Denied/unknown/observed are preserved; no record is a timeless idempotency key. */
export function queryOperationHistory(taskId: string, host: RuntimeHost, operations: OperationView[], query: HistoryQuery,
  access?: HostEnvironmentAccess) {
  if (query.hostId !== host.id) throw new Error('Host history is outside the current authorization');
  const words = redactOutput(query.query ?? '').toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const current = hostEnvironmentSnapshot(host, access);
  const owned = mergeOperationViews(operations).filter((op) => op.taskId === taskId && op.hostId === host.id
    && (!op.loginAs || op.loginAs === host.username)).reverse();
  const matches = owned.filter((op) => {
    const haystack = redactOutput(`${op.id}\n${op.executionJob?.jobId ?? ''}\n${op.preview}\n${op.outputTail ?? ''}`).toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const cursor = query.beforeOperationId ? matches.findIndex((op) => op.id === query.beforeOperationId) : -1;
  if (query.beforeOperationId && cursor < 0) throw new Error('History cursor is no longer in this query; restart the query');
  const limit = query.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid history page size');
  const page = matches.slice(cursor + 1, cursor + 1 + limit);
  const result = { version: 1, kind: 'operation-history', taskId, hostId: host.id,
    authority: 'historical actions and observations only; current state must be checked read-only if needed; never replay to recover output',
    totalMatches: matches.length, nextBeforeOperationId: cursor + 1 + page.length < matches.length ? page.at(-1)!.id : null,
    operations: page.map((op) => ({
      operationId: op.id, createdAt: op.createdAt,
      binding: op.executionContext && current.connectionId && op.loginAs === host.username
        ? op.executionContext.connectionId === current.connectionId ? 'same-connection-observation' : 'historical-connection'
        : 'unknown-connection',
      connectionId: op.executionContext?.connectionId ?? null,
      terminalId: op.executionContext?.terminalId ?? op.logRef ?? null,
      terminalGeneration: op.executionContext?.terminalGeneration ?? null,
      loginAs: op.loginAs === undefined ? null : redactOutput(op.loginAs),
      runAs: op.runAs === undefined ? null : redactOutput(op.runAs),
      action: { kind: op.kind, preview: redactOutput(op.preview).slice(0, 384),
        cwd: op.commandSource?.cwd === undefined ? null : redactOutput(op.commandSource.cwd).slice(0, 512),
        cwdTruncated: (op.commandSource?.cwd.length ?? 0) > 512 },
      observation: { status: op.status, readOnly: op.readOnly ?? null, effects: op.effects ?? null,
        exitObserved: op.exitObserved ?? false, exitCode: op.exitCode ?? null, completedAt: op.completedAt ?? null,
        outputExcerpt: redactOutput(op.outputTail ?? '').slice(-768),
        outputIsExcerpt: true, reconciliation: op.reconciliation ? { kind: op.reconciliation.kind, at: op.reconciliation.at,
          outcome: op.reconciliation.outcome ?? null, evidenceOperationIds: (op.reconciliation.evidenceOperationIds ?? []).slice(0, 16),
          omittedEvidenceIds: Math.max(0, (op.reconciliation.evidenceOperationIds?.length ?? 0) - 16) } : null },
      executionJob: op.executionJob?.operationId === op.id && op.executionJob.taskId === taskId && op.executionJob.hostId === host.id
        ? { version: 1, jobId: redactOutput(op.executionJob.jobId).slice(0, 128), status: op.executionJob.status,
          observedAt: op.executionJob.updatedAt, startedAt: op.executionJob.startedAt ?? null,
          pid: op.executionJob.pid ?? null, exitObserved: op.executionJob.exitObserved, exitCode: op.executionJob.exitCode ?? null,
          stopRequestedAt: op.executionJob.stopRequestedAt ?? null, unknownReason: op.executionJob.unknownReason ?? null,
          health: 'not-established' } : null,
      currentState: 'not-established-by-history',
      logRetrieval: { tool: 'read_operation_log', operationId: op.id, cursor: 0, retention: 'not-guaranteed' }
    })) };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32768 && result.operations.length > 1) {
    result.operations.pop(); result.nextBeforeOperationId = result.operations.at(-1)!.operationId;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32768) throw new Error('History observation exceeds the safe page limit');
  return result;
}

export function createWorkspaceContextTools(taskId: string, hosts: RuntimeHost[], operations: () => OperationView[],
  access?: HostEnvironmentAccess, assertActive: () => void = () => {}): BusinessTool[] {
  const hostFor = (id: string) => {
    assertActive();
    const host = hosts.find((candidate) => candidate.id === id);
    if (!host) throw new Error('Host is outside the current authorization');
    return host;
  };
  const history: BusinessTool<HistoryQuery> = {
    access: 'query', available: () => hosts.length > 0,
    name: 'query_operation_history', label: 'Find previous conversation operations', replay: 'never', parameters: historyParameters,
    description: 'Search all recorded actions/observations in this conversation and authorized login, including before compaction. Query uses literal words, not regex. Pages are newest first. Previous success is not current state or permission to repeat. Use read_operation_log for full retained output.',
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted();
      const data = queryOperationHistory(taskId, hostFor(input.hostId), operations(), input, access);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: data };
    }
  };
  const parameters = Type.Object({ hostId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
  const environment: BusinessTool<Static<typeof parameters>> = {
    access: 'query', available: () => hosts.length > 0,
    name: 'inspect_host_environment', label: 'Observe connected host environment', replay: 'never', parameters,
    description: 'Bounded read-only OS/version/architecture/login-directory/tool-presence observation on an already connected host, resolved against the same fixed PATH that command execution uses. No connection, privilege escalation or secret environment reads. toolPresence is existence on that PATH for the probed identity only. toolReadiness is separate evidence that a tracked tool (docker/systemctl) actually answered: one literal command, exit 0, with the identity (observedAs) and time (observedAt); absence of an entry means unknown, never unavailable. presenceStale marks a later dispatched mutation that may have changed presence/readiness until re-probed. docker present does not mean the daemon is usable and systemctl present does not mean systemd is operable; a prior responsive fact is not proof for the next invocation. loginDirectory is the login start directory, not the current operation cwd. Unknown on failure; cache may be up to five seconds old. Login metadata is not root capability and root execution has separate facts.',
    execute: async (_id, { hostId }, signal) => {
      const host = hostFor(hostId); signal?.throwIfAborted();
      const observation = access ? await access.refresh(host.id, host.username, signal) : hostEnvironmentSnapshot(host);
      signal?.throwIfAborted(); hostFor(hostId);
      const data = { kind: 'host-environment', ...observation };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: data };
    }
  };
  return [history, environment];
}
