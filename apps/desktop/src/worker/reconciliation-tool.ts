import { Type, type Static } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';
import { operationOutcomeResolvable, type OperationView } from '@cloudhelm/contracts';
import { isReconciliationEvidence, mergeOperationViews } from './runtime-facts.js';
import { hasJournalCredentials } from './journal-secrets.js';

const parameters = Type.Object({ operationId: Type.String({ maxLength: 200 }),
  evidenceOperationIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, uniqueItems: true }),
  outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
  explanation: Type.String({ minLength: 10, maxLength: 2000 }) });
type Code = 'target-unavailable' | 'target-not-resolvable' | 'already-resolved' | 'evidence-missing'
  | 'evidence-unavailable' | 'evidence-wrong-host' | 'evidence-not-newer' | 'evidence-not-query'
  | 'evidence-not-successful' | 'explanation-invalid' | 'original-still-running' | 'outcome-recorded';

export function createReconciliationTool(deps: {
  taskId: string;
  operations(): readonly OperationView[];
  /** Synchronous exit/liveness check and unlock. No asynchronous gap before recording the outcome. */
  reconcile(operation: OperationView): boolean;
  reconciled(operation: OperationView): void;
}): BusinessTool<Static<typeof parameters>> {
  return { name: 'record_reconciled_result', label: 'Record an observed outcome after recovery', replay: 'never', parameters,
    description: 'Only for an unresolved UNKNOWN or failed-with-possible-effects operation in this conversation. Cite newer, same-host, successful SafetyGate-classified effect-free observation IDs and explain what they prove; never use another write as evidence. Reuse eligible existing observations. Already-resolved targets allow an empty evidence list, need no new check and return their current resolution without changing it. Risk acceptance does not prove success. Running originals cannot be cleared; this never replays an action.',
    execute: async (_id, value) => {
      const operations = mergeOperationViews(deps.operations()).filter((operation) => operation.taskId === deps.taskId);
      const operation = operations.find((item) => item.id === value.operationId);
      const reply = (code: Code, guidance: string, isError = true) => {
        const resolution = operation?.reconciliation;
        const details = { operationId: operation?.id, code, guidance,
          ...(code === 'already-resolved' || code === 'outcome-recorded' ? {
            status: operation?.status, reconciledAt: operation?.reconciledAt,
            reconciliation: resolution ? { kind: resolution.kind, at: resolution.at,
              ...(resolution.kind === 'evidence' ? { outcome: resolution.outcome,
                evidenceOperationIds: resolution.evidenceOperationIds?.slice(-5) } : {}) } : undefined
          } : {}),
          eligibleEvidenceOperationIds: operation && operationOutcomeResolvable(operation)
            ? operations.filter((item) => isReconciliationEvidence(operation, item)).slice(-5).map((item) => item.id) : [] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details, isError };
      };
      if (!operation) return reply('target-unavailable', 'Target is absent or outside this conversation. Use its source conversation/host recovery card; this tool cannot resolve another conversation.');
      if (operation.reconciledAt) return reply('already-resolved',
        'No action needed: this target was already handled. No new check or unlock was performed. Risk acceptance is not proof of success; use the recorded resolution, not the requested replacement outcome.', false);
      if (['running', 'proposed', 'approved'].includes(operation.status)) return reply('original-still-running',
        'The original operation has not settled. Do not clear it or replay it; wait or explicitly stop it, then establish its actual outcome.');
      if (!operationOutcomeResolvable(operation)) return reply('target-not-resolvable',
        'This target does not require uncertain-effect reconciliation. A classified query or operation with no effects needs no reconciliation; a known success may instead need submit_verification. Do not run new checks merely to clear it.');
      if (!value.evidenceOperationIds.length || value.evidenceOperationIds.length > 20
        || new Set(value.evidenceOperationIds).size !== value.evidenceOperationIds.length) return reply('evidence-missing', 'Supply 1–20 distinct eligible existing evidence IDs.');
      const evidence = value.evidenceOperationIds.map((id) => operations.find((item) => item.id === id));
      if (evidence.some((item) => !item)) return reply('evidence-unavailable', 'Some evidence is absent or outside this conversation. Use eligible IDs from this conversation.');
      if (evidence.some((item) => item!.hostId !== operation.hostId)) return reply('evidence-wrong-host', 'Evidence must observe the target host. Reuse an eligible same-host observation.');
      if (evidence.some((item) => item!.createdAt <= operation.createdAt)) return reply('evidence-not-newer', 'Evidence must be newer than the original operation. Reuse eligible newer observations.');
      if (evidence.some((item) => item!.kind !== 'command' || item!.readOnly !== true)) return reply('evidence-not-query', 'A write or unclassified command is not effect-free evidence. Use the eligible observation IDs; do not replay the write.');
      if (evidence.some((item) => item!.status !== 'succeeded' || item!.reconciliation?.kind === 'risk-accepted')) return reply('evidence-not-successful', 'Evidence needs an observed successful query, not failed/unknown output or accepted risk.');
      if (value.explanation.trim().length < 10 || value.explanation.length > 2000 || hasJournalCredentials(value.explanation)) return reply('explanation-invalid', 'Provide a bounded concrete explanation without credentials. Nothing was stored or unlocked.');
      if (!deps.reconcile(operation)) return reply('original-still-running', 'The execution coordinator cannot confirm the original process has exited. Wait or explicitly stop it; this check cannot unlock a live original.');
      operation.status = value.outcome;
      operation.reconciledAt = Date.now();
      operation.reconciliation = { kind: 'evidence', outcome: value.outcome,
        evidenceOperationIds: [...value.evidenceOperationIds], explanation: value.explanation, at: operation.reconciledAt };
      operation.reason = `已核验：${value.explanation}；证据：${value.evidenceOperationIds.join(', ')}`;
      deps.reconciled(operation);
      return reply('outcome-recorded', 'Observed outcome recorded without replaying a remote action. This does not authorize any subsequent change.', false);
    }
  };
}
