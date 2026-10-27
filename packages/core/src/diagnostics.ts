import { redactOutput } from './redaction.js';

export interface DiagnosticEvent {
  authentication?: string; authenticationAttempts?: number; failureKind?: string; effects?: string;
  event: string;
  level?: 'debug' | 'info' | 'error';
  taskId?: string; hostId?: string; operationId?: string; requestId?: string;
  text?: string; command?: string; cwd?: string; path?: string; role?: string;
  tool?: string; status?: string; ruleId?: string; runAs?: string; loginAs?: string;
  sessionId?: string; sha256?: string; model?: string; provider?: string;
  roundId?: string; logicalRequestId?: string; purpose?: string; transport?: string; resumeReason?: string;
  reconciliationKind?: string; classification?: string; errorCode?: string;
  attempt?: number; policyRevision?: number; readOnly?: boolean; responseAttributed?: boolean;
  evidenceOperationIds?: string[]; evidenceOmitted?: number;
  durationMs?: number; request?: number; exitCode?: number; size?: number;
}
const textFields = ['event', 'taskId', 'hostId', 'operationId', 'requestId', 'text', 'command', 'cwd', 'path',
  'role', 'tool', 'status', 'ruleId', 'runAs', 'loginAs', 'sessionId', 'sha256', 'model', 'provider', 'authentication', 'failureKind', 'effects'] as const;
const numericFields = ['durationMs', 'request', 'exitCode', 'size', 'authenticationAttempts', 'attempt', 'policyRevision', 'evidenceOmitted'] as const;
const metadataFields = ['roundId', 'logicalRequestId', 'purpose', 'transport', 'resumeReason', 'reconciliationKind', 'classification', 'errorCode'] as const;

/** Explicit allowlist; never pass a runtime call, credentials, or a model response through here. */
export function safeDiagnostic(input: DiagnosticEvent): DiagnosticEvent {
  const result: DiagnosticEvent = { event: 'diagnostic' };
  for (const field of textFields) if (typeof input[field] === 'string') {
    result[field] = redactOutput(input[field]!).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').slice(0, 32_768);
  }
  for (const field of numericFields) if (typeof input[field] === 'number' && Number.isFinite(input[field])) result[field] = input[field];
  for (const field of metadataFields) if (typeof input[field] === 'string')
    result[field] = redactOutput(input[field]!).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200);
  if (typeof input.readOnly === 'boolean') result.readOnly = input.readOnly;
  if (typeof input.responseAttributed === 'boolean') result.responseAttributed = input.responseAttributed;
  if (Array.isArray(input.evidenceOperationIds)) {
    result.evidenceOperationIds = input.evidenceOperationIds.filter((id) => typeof id === 'string' && /^[\w.:-]{1,200}$/u.test(id)).slice(0, 8);
    result.evidenceOmitted = input.evidenceOperationIds.length - result.evidenceOperationIds.length;
  }
  result.level = ['debug', 'info', 'error'].includes(input.level ?? '') ? input.level : 'debug';
  return result;
}
