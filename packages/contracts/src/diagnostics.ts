/** Sanitized diagnostics only. Never transport credentials or raw model/IPC objects. */
export interface DiagnosticRecord {
  event: string; level?: 'debug' | 'info' | 'error';
  taskId?: string; hostId?: string; operationId?: string; requestId?: string;
  text?: string; command?: string; cwd?: string; path?: string; role?: string;
  tool?: string; status?: string; ruleId?: string; runAs?: string; loginAs?: string;
  sessionId?: string; sha256?: string; model?: string; provider?: string;
  durationMs?: number; request?: number; exitCode?: number; size?: number;
}
