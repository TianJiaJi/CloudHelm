import { redactOutput } from './redaction.js';

export interface DiagnosticEvent {
  event: string;
  level?: 'debug' | 'info' | 'error';
  taskId?: string; hostId?: string; operationId?: string; requestId?: string;
  text?: string; command?: string; cwd?: string; path?: string; role?: string;
  tool?: string; status?: string; ruleId?: string; runAs?: string; loginAs?: string;
  sessionId?: string; sha256?: string; model?: string; provider?: string;
  durationMs?: number; request?: number; exitCode?: number; size?: number;
}
const textFields = ['event', 'taskId', 'hostId', 'operationId', 'requestId', 'text', 'command', 'cwd', 'path',
  'role', 'tool', 'status', 'ruleId', 'runAs', 'loginAs', 'sessionId', 'sha256', 'model', 'provider'] as const;
const numericFields = ['durationMs', 'request', 'exitCode', 'size'] as const;

/** Explicit allowlist; never pass a runtime call, credentials, or a model response through here. */
export function safeDiagnostic(input: DiagnosticEvent): DiagnosticEvent {
  const result: DiagnosticEvent = { event: 'diagnostic' };
  for (const field of textFields) if (typeof input[field] === 'string') {
    result[field] = redactOutput(input[field]!).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').slice(0, 32_768);
  }
  for (const field of numericFields) if (typeof input[field] === 'number' && Number.isFinite(input[field])) result[field] = input[field];
  result.level = ['debug', 'info', 'error'].includes(input.level ?? '') ? input.level : 'debug';
  return result;
}
