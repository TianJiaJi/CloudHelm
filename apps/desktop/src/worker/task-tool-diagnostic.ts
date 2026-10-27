import { createHash } from 'node:crypto';
import { redactOutput, type DiagnosticEvent, type SessionEvent } from '@cloudhelm/core';

/** Translate tool lifecycle metadata. The TaskRunner's diagnostic sink still
 * performs the allowlist/redaction pass; never include a file's contents. */
export function taskToolDiagnostic(event: Extract<SessionEvent, { type: 'tool-start' | 'tool-end' }>): DiagnosticEvent {
  if (event.type === 'tool-end') return { event: 'tool.end', requestId: event.id,
    tool: event.name, status: event.isError ? 'failed' : 'succeeded' };
  const args = event.args as Record<string, unknown>;
  const string = (key: string) => typeof args?.[key] === 'string' ? args[key] as string : undefined;
  const payload = string('content') ?? string('command');
  return { event: 'tool.start', requestId: event.id, tool: event.name,
    hostId: string('hostId'), cwd: string('cwd'), path: string('path'),
    size: payload === undefined ? undefined : Buffer.byteLength(payload),
    sha256: payload === undefined ? undefined : createHash('sha256').update(redactOutput(payload)).digest('hex') };
}
