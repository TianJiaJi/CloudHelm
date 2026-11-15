import { FileEditService } from './file-edit-service.js';
import { controlledFileTools } from './controlled-file-tools.js';
import { createServiceTool } from './service-tool.js';
import { createRemoteFileEditTool } from './remote-file-edit-tool.js';
import { createRemoteFilePrepareTool } from './remote-file-prepare-tool.js';
import { OperationPrivilege } from './operation-privilege.js';
import { createHash, randomUUID } from 'node:crypto';
import { OutputRedactor, PrivilegeError, privilegeGuidance, redactOutput, type BusinessTool } from '@cloudhelm/core';
import { Type, type Static } from 'typebox';
import { createSelectedReadTool } from '@cloudhelm/adapters';
import type { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { OutputExpectationSchema } from '@cloudhelm/contracts';
import { hasJournalCredentials } from './journal-secrets.js';
import { blockedOperationFeedback } from './operation-feedback.js';


function outOfScope() {
  return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }], details: { code: 'out-of-scope-host' }, isError: true };
}
export function createRemoteTools(deps: RemoteToolDependencies, gate: SafetyGate) {
    const privilege = new OperationPrivilege(deps);
    const files = deps.controlledFiles && deps.taskId ? new FileEditService(deps, gate) : undefined;
    const parameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
      privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])),
      background: Type.Optional(Type.Boolean()),
      outputExpectation: Type.Optional(OutputExpectationSchema) }, { additionalProperties: false });
    const tool: BusinessTool<Static<typeof parameters>> = {
      name: 'run_remote', label: 'Execute an audited remote SSH command',
      description: 'Execute one logical action in an authorized SSH terminal. Use cwd; prefer absolute paths. Default waits for exit. For explicitly requested temporary long-running work set background=true: returns a job observation after process start, NOT authentication success, readiness or exit. Inspect via query_operation_history/read_operation_log; use service managers for production services. For a required root action set privilege=root and provide one literal command WITHOUT sudo/su: backend verifies identity, uses sudo when needed, and can offer confirmed su only after a proven not-started sudo failure. Passwords are requested privately only when needed. No root-session setup is required. sessionId is legacy/explicit-identity access, incompatible with privilege=root. Never retry unknown effects or switch identity after cancellation/denial. Optional outputExpectation compares this run only, not whole-task success; no report submission is required. Read truncated output with read_operation_log, never replay for output.',
      parameters,
      replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        if (params.privilege === 'root' && params.sessionId !== undefined) return blockedOperationFeedback(_id,
          'conflicting-identity', 'Use privilege=root or sessionId, never both. No terminal was allocated.');
        if (params.outputExpectation && hasJournalCredentials(JSON.stringify(params.outputExpectation))) return {
          content: [{ type: 'text' as const, text: 'Expected output contains recognizable credentials; nothing executed. Remove credentials, never repeat them.' }], isError: true, details: undefined };
        const execute = async (lifetime?: AbortSignal) => {
          const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
          const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command: params.command,
            ...(params.background ? { executionMode: 'background' as const } : {}),
            outputExpectation: params.outputExpectation ? structuredClone(params.outputExpectation) : undefined,
            scope: deps.scope(host, terminalId, params.cwd) };
          return params.privilege === 'root' ? privilege.run(gate, host, operation, lifetime)
            : deps.runOperation(gate, operation, lifetime, host.label);
        };
        if (!params.background) return execute(signal);
        if (!deps.background) throw new Error('Background execution is unavailable; no command was sent');
        return deps.background(signal, execute);
      }
    };
    const readParameters = Type.Object({ hostId: Type.String(), path: Type.String(), cwd: Type.Optional(Type.String()),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })),
      privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])) },  { additionalProperties: false });
    const readTool: BusinessTool<Static<typeof readParameters>> = {
      access: 'query', deferred: true, available: () => !!files || !!deps.readRemoteFile,
      name: 'read_remote_file', label: 'Read a bounded remote file for editing',
      description: 'Read bounded regular UTF-8 text, default 128 KiB, max 1 MiB. Current identity is default; explicit privilege=root uses the controlled driver, SafetyGate and private on-demand sudo authentication. Without that driver root is refused, not silently ignored. Complete safe source has a sha256 for prepare_remote_edit; truncated/redacted source grants no edit hash. No symlink/directory reads, implicit identity switching or secret values in chat. A hash alone never authorizes a commit.',
      parameters: readParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        if (files && (params.privilege === 'root' || !deps.readRemoteFile)) return files.read(_id, params, signal);
        if (params.privilege === 'root') return blockedOperationFeedback(_id, 'file-transactions-unavailable', 'Controlled root reader is unavailable; no automatic fallback.', undefined, true);
        // Authorization denials must reach the audited reader too, not vanish here.
        if (!deps.readRemoteFile) return { content: [{ type: 'text' as const, text: 'Remote file reading is unavailable' }], details: undefined, isError: true };
        try {
          const snapshot = await deps.readRemoteFile(params.hostId, params.path, params.cwd, signal, params.maxBytes);
          const redactor = new OutputRedactor(1_048_576);
          const content = redactor.push(snapshot.content) + redactor.finish();
          const redacted = snapshot.redacted === true || content !== snapshot.content;
          // Masked text is an observation, not an editable complete source. Do not
          // supply its raw-file version token for a destructive whole-file overwrite.
          const details = { path: redactOutput(params.path), bytes: snapshot.bytes, truncated: snapshot.truncated, redacted,
            sha256: !snapshot.truncated && !redacted ? snapshot.sha256 ?? null : null,
            mode: (snapshot.mode & 0o7777).toString(8), uid: snapshot.uid, gid: snapshot.gid };
          return { content: [{ type: 'text' as const, text: `[Remote file ${JSON.stringify(details)}]\n${content}` }],
            details, structuredContent: { ...details, content } };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: `Remote read failed: ${redactOutput(error instanceof Error ? error.message : String(error))}` }],
            details: undefined, isError: true };
        }
      }
    };
    const writeParameters = Type.Object({ hostId: Type.String(), path: Type.String(), content: Type.String(), cwd: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      expectedSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
      createOnly: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
    const writeTool: BusinessTool<Static<typeof writeParameters>> = {
      name: 'write_remote_file', label: 'Write an audited remote file',
      description: 'Create new UTF-8 files only over SFTP, at most 1 MiB; parent directory must exist. Current backend refuses existing-file replacement because complete ACL/xattr preservation is unverified, even with a hash or root SSH. expectedSha256 is legacy and rejected before terminal allocation. New files use private exclusive staging and non-overwriting rename; createOnly=true is explicit. Verify the read-back hash. Use prepare_remote_edit only for a read-only diff, not a commit. Never bypass with identity changes, shell staging or delete/recreate. Sudo/su contexts do not elevate SFTP.',
      parameters: writeParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        if (params.createOnly && params.expectedSha256) return blockedOperationFeedback(_id,
          'invalid-file-condition', 'Choose createOnly or expectedSha256, not both. No terminal was allocated.');
        if (params.expectedSha256 !== undefined) return blockedOperationFeedback(_id,
          'remote-edit-unsupported', 'Existing-file replacement is unavailable until ACL/xattr preservation can be verified. A hash is not an exception. Use prepare_remote_edit only to preview; do not bypass with another tool or identity. No terminal or review was started.');
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: params.path, content: params.content,
          ...(params.createOnly ? { createOnly: true } : {}),
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const deleteParameters = Type.Object({ hostId: Type.String(), path: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) }, { additionalProperties: false });
    const deleteTool: BusinessTool<Static<typeof deleteParameters>> = {
      name: 'delete_remote_file', label: 'Delete an audited remote file',
      description: 'Delete only a regular file on an authorized host, retaining a private content-only recovery copy. It does not restore owner/group/mode, ACL/xattr or service state. Directories and symlinks are refused. Never use deletion to bypass an existing-file replacement refusal.',
      parameters: deleteParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'delete-path', path: params.path,
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const listLocalParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false });
    const listLocalTool: BusinessTool<Static<typeof listLocalParameters>> = {
      access: 'query', deferred: true, available: () => deps.localFiles.hasScopes === true,
      name: 'list_selected_directory', label: 'List a selected local directory',
      description: 'Page a user-selected absolute local directory in stable name order. At most 200 entries and 50 KiB per response; a bounded metadata scan supports up to 10000 entries. Pass nextCursor unchanged as cursor for the same path. Changed directories or expired cursors require listing again. Every page rechecks authorization. File sizes are actual bytes; null means unknown/not a regular file, never zero. Symlink targets are not traversed.',
      parameters: listLocalParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        try {
          const { entries, ...metadata } = await deps.localFiles.list(params.path, params.cursor, signal);
          const details = { ...metadata, entriesReturned: entries.length };
          return { content: [{ type: 'text', text: `[Selected directory page ${JSON.stringify(details)}]\n${JSON.stringify(entries)}` }], details, structuredContent: { ...details, entries } };
        } catch (error) { return { content: [{ type: 'text', text: String(error) }], details: undefined, isError: true }; }
      }
    };
    const readLocalTool = { ...createSelectedReadTool((path, signal) => deps.localFiles.read(path, signal)),
      available: () => deps.localFiles.hasScopes === true };
    const uploadParameters = Type.Object({ hostId: Type.String(), localPath: Type.String(), remotePath: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) }, { additionalProperties: false });
    const uploadTool: BusinessTool<Static<typeof uploadParameters>> = {
      name: 'upload_selected_file', label: 'Upload an audited selected file',
      description: 'Upload a regular file of at most 1 MiB from a user-selected local source to a new file on an authorized SSH host. Existing targets are refused because ACL/xattr preservation is unverified. Changes require safety review; do not delete/recreate to evade the refusal.',
      parameters: uploadParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        try {
          const { data, scope } = await deps.localFiles.read(params.localPath, signal);
          return deps.runOperation(gate, { id: randomUUID(), kind: 'upload', localPath: params.localPath,
            localRoot: scope.path, remotePath: params.remotePath, size: data.length,
            contentSha256: createHash('sha256').update(data).digest('hex'),
            scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
        } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], details: undefined, isError: true }; }
      }
    };
  const rootParameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.String(), reason: Type.String(),
    method: Type.Optional(Type.Union([Type.Literal('sudo'), Type.Literal('ssh'), Type.Literal('su')])) }, { additionalProperties: false });
  const rootTool: BusinessTool<Static<typeof rootParameters>> = {
    name: 'request_root_session', label: 'Advanced explicit identity access (legacy)',
    description: 'Advanced/legacy path only; normal root actions use run_remote privilege=root without a session. Root SSH requires explicit user selection, never automatic fallback. Default method=sudo: confirm a prepared context, no probe, password or business command runs. Each later literal command is sudo-elevated before review; this is NOT a verified root login. Prefer actual bounded sudo actions. Explicit ssh/su alternatives need user confirmation; su normally needs ROOT password, not login sudo password. Supply intended action/reason/cwd; this tool never executes it. Follow structured feedback; never switch identity after a control stop or replay work. Sudo/su do not elevate SFTP.',
    parameters: rootParameters, replay: 'never',
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
      if (!host) return outOfScope();
      if (!deps.requestRoot) throw new Error('Root sessions unavailable');
      try {
        const session = await deps.requestRoot(host, params.command, params.cwd, params.reason, signal, params.method ?? 'sudo');
        return { content: [{ type: 'text', text: JSON.stringify(session) }], details: undefined };
      } catch (error) {
        const privilege = error instanceof PrivilegeError ? error.feedback : undefined;
        return { content: [{ type: 'text', text: JSON.stringify({ privilege, guidance: privilege ? privilegeGuidance(privilege)
          : 'Privilege context unavailable; no intended business action was dispatched. Wait for explicit user instructions; no automatic fallback.' }) }], details: { privilege }, isError: true };
      }
    }
  };
  const tools = [createServiceTool(deps, gate), rootTool, tool, readTool, createRemoteFilePrepareTool(deps, files), ...controlledFileTools(files), createRemoteFileEditTool(deps, gate), writeTool, deleteTool, listLocalTool, readLocalTool, uploadTool];
  // Pre-dispatch refusals create no operation record, so surface a fixed reason code
  // for diagnosis. The code is allowlisted; arguments and content never reach the log.
  return deps.refused ? (tools as BusinessTool<any>[]).map((item) => ({ ...item,
    execute: async (id: string, args: any, signal?: AbortSignal) => {
      const reply = await item.execute(id, args, signal);
      const code = (reply?.details as { code?: unknown } | undefined)?.code;
      if (reply?.isError) deps.refused!(item.name, typeof code === 'string' && /^[a-z0-9-]{1,64}$/u.test(code) ? code : 'tool-refused');
      return reply;
    } })) : tools;
}
