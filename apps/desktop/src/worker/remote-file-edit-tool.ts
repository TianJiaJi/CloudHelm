import { createHash, randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { OutputRedactor, redactOutput, type BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { resolveRemoteReadTarget } from './remote-read-guard.js';

const MAX_BYTES = 1_048_576;
const parameters = Type.Object({
  hostId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }),
  expectedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  oldText: Type.String({ minLength: 1, maxLength: MAX_BYTES }),
  newText: Type.String({ maxLength: MAX_BYTES })
}, { additionalProperties: false });

/** Prepare a literal, single-location edit; only runOperation can authorize mutation.
 * Root routing and secret-file editing are deliberately not claimed by this tool. */
export function createRemoteFileEditTool(deps: RemoteToolDependencies, gate: SafetyGate): BusinessTool<Static<typeof parameters>> {
  return { name: 'edit_remote_file', label: 'Edit one bounded remote text fragment', replay: 'never',
    available: () => !!deps.readRemoteFile, parameters,
    description: 'Replace exactly one unique literal oldText with newText in an absolute remote UTF-8 file (1 MiB limit). Requires the complete unredacted sha256 from read_remote_file. No regex or replace-all; ambiguous/no-match/no-op edits are refused. Backend reads the original, checks its version, prepares the exact replacement for SafetyGate, then rechecks before commit and reads back. Not atomic against external writers. No privilege/session fields: uses the current SSH login; protected or redacted files require manual handling.',
    execute: async (id, params, signal) => {
      const blocked = (code: string, text: string) => blockedOperationFeedback(id, code, text);
      const host = deps.hosts.find((item) => item.id === params.hostId);
      if (!host || !deps.readRemoteFile) return blocked('remote-edit-unavailable', 'File editing is outside the current authorization; nothing written.');
      signal?.throwIfAborted();
      try {
        const target = resolveRemoteReadTarget(params.path, '/');
        const snapshot = await deps.readRemoteFile(host.id, target, '/', signal, MAX_BYTES);
        const source = snapshot.content;
        if (snapshot.truncated || Buffer.byteLength(source) > MAX_BYTES || !snapshot.sha256
          || snapshot.sha256 !== params.expectedSha256
          || createHash('sha256').update(source).digest('hex') !== params.expectedSha256)
          return blocked('remote-edit-source-changed', 'The complete source version is unavailable or changed; read the file again. Nothing written.');
        const redactor = new OutputRedactor(MAX_BYTES);
        if (redactor.push(source) + redactor.finish() !== source)
          return blocked('remote-edit-unavailable', 'The source needs redaction; a masked observation cannot authorize replacing its original. Use manual editing. Nothing written.');
        const start = source.indexOf(params.oldText);
        if (!params.oldText || start < 0 || source.indexOf(params.oldText, start + 1) !== -1)
          return blocked('remote-edit-ambiguous', 'oldText must match exactly one location, including overlapping matches. Nothing written.');
        const content = source.slice(0, start) + params.newText + source.slice(start + params.oldText.length);
        if (content === source || content.includes('\0') || Buffer.byteLength(content) > MAX_BYTES)
          return blocked('remote-edit-invalid', 'Replacement must change the file, contain no NUL bytes and fit within 1 MiB. Nothing written.');
        signal?.throwIfAborted();
        const terminal = await deps.ensureTerminal(host.id);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: target, content,
          expectedSha256: params.expectedSha256, scope: deps.scope(host, terminal, '/') }, signal, host.label);
      } catch (error) {
        // Dispatch is returned (not awaited) above: a later executor failure must not
        // be relabelled as a no-effect preparation failure.
        return blocked('remote-edit-unavailable', `Edit preparation failed; nothing written: ${redactOutput(error instanceof Error ? error.message : String(error))}`);
      }
    }
  };
}
