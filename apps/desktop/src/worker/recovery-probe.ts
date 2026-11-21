import { randomUUID } from 'node:crypto';
import { redactOutput, serviceObservation, serviceQuery, validServiceUnit,
  type OperationResult, type OperationScope, type ProposedOperation } from '@cloudhelm/core';

/** Bounded, redacted evidence a completed recovery probe collected about an unknown result. */
export interface ProbeEvidence {
  operationId: string;
  status: OperationResult['status'];
  exitCode: number | null;
  /** Parsed read-only service properties; every value redacted and bounded. */
  observations: Record<string, string>;
}

/** Tool feedback shape the probe findings attach to; existing fields stay untouched. */
export interface ToolFeedback {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
}

/** Phase 1 probe template: the exact service unit the unknown operation already
 * carried through review, or undefined when no whitelisted template applies.
 * Single layer: a probe never spawns another probe; an invalid unit means no probe. */
export function recoveryProbeUnit(operation: ProposedOperation): string | undefined {
  if (operation.kind !== 'command' || operation.probe !== undefined || !operation.serviceUnit
    || !validServiceUnit(operation.serviceUnit)) return undefined;
  return operation.serviceUnit;
}

/** Builds the whitelisted read-only probe for an unknown result, or undefined when
 * no template applies. The probe is never the original command replayed. */
export function buildRecoveryProbe(operation: ProposedOperation, scope: OperationScope): ProposedOperation | undefined {
  const unit = recoveryProbeUnit(operation);
  if (!unit) return undefined;
  return { id: randomUUID(), kind: 'command', command: serviceQuery(unit),
    probe: 'recovery', recoveryTarget: operation.id,
    // The probe inherits the original delegation (one work unit, audit-coherent) but
    // carries no toolCallId: evidence collection is a backend decision, not the model's.
    delegationId: operation.delegationId,
    scope: { ...scope } };
}

/** Parses a finished probe result into bounded evidence; values are redacted untrusted data. */
export function probeEvidence(result: OperationResult): ProbeEvidence {
  const parsed = serviceObservation(result.stdoutTail);
  const observations: Record<string, string> = {};
  for (const key of Object.keys(parsed)) observations[key] = redactOutput(parsed[key] ?? '').slice(0, 200);
  return { operationId: result.operationId, status: result.status,
    exitCode: typeof result.exitCode === 'number' && Number.isInteger(result.exitCode) ? result.exitCode : null, observations };
}

/** Only-add: appends the probe observation after the existing feedback text and adds a
 * `recoveryProbe` structured field. The original feedback shape and text stay intact. */
export function appendProbeFindings<T extends ToolFeedback>(feedback: T, evidence: ProbeEvidence): T {
  const facts = Object.keys(evidence.observations).map((key) => `${key}=${evidence.observations[key]}`).join(', ');
  const segment = `Recovery probe (read-only systemd query): operationId=${evidence.operationId}, `
    + `status=${evidence.status}${evidence.exitCode === null ? '' : `, exit=${evidence.exitCode}`}${facts ? `, ${facts}` : ''}。\n`
    + '原操作结果仍为 unknown；探针不是重放，未经核验不得重发原命令。'
    + '可用探针操作 ID 作为 record_reconciled_result 的核验证据。';
  return { ...feedback,
    structuredContent: { ...feedback.structuredContent, recoveryProbe: evidence },
    content: feedback.content.map((part) => part.type === 'text'
      ? { ...part, text: `${part.text}\n${segment}` } : part) };
}
