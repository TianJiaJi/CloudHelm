import { createServiceTool } from './service-tool.js';
import { createHash, randomUUID } from 'node:crypto';
import { PrivilegeError, privilegeGuidance, type BusinessTool } from '@cloudhelm/core';
import { Type, type Static } from 'typebox';
import { createSelectedReadTool } from '@cloudhelm/adapters';
import type { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { OutputExpectationSchema } from '@cloudhelm/contracts';
import { hasJournalCredentials } from './journal-secrets.js';


function outOfScope() {
  return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }], details: undefined, isError: true };
}
export function createRemoteTools(deps: RemoteToolDependencies, gate: SafetyGate) {
    const parameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
      outputExpectation: Type.Optional(OutputExpectationSchema) });
    const tool: BusinessTool<Static<typeof parameters>> = {
      name: 'run_remote', label: 'Execute an audited remote SSH command',
      description: 'Perform one logical action on an authorized host. Issue one remote call at a time and wait for its result before the next. Do not chain independent actions or print decorative separators. Use cwd instead of cd prefixes. Commands are shown in its dedicated real SSH terminal after safety review. Use absolute paths when possible. sessionId may select a prepared sudo context or confirmed root session. Sudo contexts elevate each literal command BEFORE review, not a root shell; cwd must be accessible to the login user. For known expected output, attach outputExpectation(expectedOutput,expectedExitCode=0) BEFORE running: backend compares the result automatically, with no submit_verification needed. Otherwise actual script completion/output is still recorded, not claimed to prove the whole goal. ls/stat are metadata observations, never file-content read-back.',
      parameters,
      replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        if (params.outputExpectation && hasJournalCredentials(JSON.stringify(params.outputExpectation))) return {
          content: [{ type: 'text' as const, text: 'Expected output contains recognizable credentials; nothing executed. Remove credentials, never repeat them.' }], isError: true, details: undefined };
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command: params.command,
          outputExpectation: params.outputExpectation ? structuredClone(params.outputExpectation) : undefined,
          scope: deps.scope(host, terminalId, params.cwd) };
        return deps.runOperation(gate, operation, signal, host.label);
      }
    };
    const writeParameters = Type.Object({ hostId: Type.String(), path: Type.String(), content: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) });
    const writeTool: BusinessTool<Static<typeof writeParameters>> = {
      name: 'write_remote_file', label: 'Write an audited remote file',
      description: 'Write a UTF-8 file over SFTP on an authorized host. Existing regular files receive a private recovery copy. Maximum 1 MiB. Parent directory must exist. sessionId may select a root SSH session; sudo/su contexts do not elevate SFTP.',
      parameters: writeParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: params.path, content: params.content,
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const deleteParameters = Type.Object({ hostId: Type.String(), path: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) });
    const deleteTool: BusinessTool<Static<typeof deleteParameters>> = {
      name: 'delete_remote_file', label: 'Delete an audited remote file',
      description: 'Delete only a regular file on an authorized host, retaining a private recovery copy. Directories and symlinks are refused.',
      parameters: deleteParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        return deps.runOperation(gate, { id: randomUUID(), kind: 'delete-path', path: params.path,
          scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
      }
    };
    const listLocalParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) });
    const listLocalTool: BusinessTool<Static<typeof listLocalParameters>> = {
      name: 'list_selected_directory', label: 'List a selected local directory',
      description: 'Page a user-selected absolute local directory in stable name order. At most 200 entries and 50 KiB per response; a bounded metadata scan supports up to 10000 entries. Pass nextCursor unchanged as cursor for the same path. Changed directories or expired cursors require listing again. Every page rechecks authorization. File sizes are actual bytes; null means unknown/not a regular file, never zero. Symlink targets are not traversed.',
      parameters: listLocalParameters, replay: 'never',
      execute: async (_id, params, signal) => {
        try {
          const { entries, ...metadata } = await deps.localFiles.list(params.path, params.cursor, signal);
          const details = { ...metadata, entriesReturned: entries.length };
          return { content: [{ type: 'text', text: `[Selected directory page ${JSON.stringify(details)}]\n${JSON.stringify(entries)}` }], details };
        } catch (error) { return { content: [{ type: 'text', text: String(error) }], details: undefined, isError: true }; }
      }
    };
    const readLocalTool = createSelectedReadTool((path, signal) => deps.localFiles.read(path, signal));
    const uploadParameters = Type.Object({ hostId: Type.String(), localPath: Type.String(), remotePath: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) });
    const uploadTool: BusinessTool<Static<typeof uploadParameters>> = {
      name: 'upload_selected_file', label: 'Upload an audited selected file',
      description: 'Upload a regular file of at most 1 MiB from a user-selected local source to an authorized SSH host. Changes require safety review.',
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
    method: Type.Optional(Type.Union([Type.Literal('sudo'), Type.Literal('ssh'), Type.Literal('su')])) });
  const rootTool: BusinessTool<Static<typeof rootParameters>> = {
    name: 'request_root_session', label: 'Request a controlled privilege context (sudo by default)',
    description: 'Default method=sudo: confirm a prepared context, no probe, password or business command runs. Each later literal command is sudo-elevated before review; this is NOT a verified root login. Prefer actual bounded sudo actions. Explicit ssh/su alternatives need user confirmation; su normally needs ROOT password, not login sudo password. Supply intended action/reason/cwd; this tool never executes it. Follow structured feedback; never switch identity after a control stop or replay work. Sudo/su do not elevate SFTP.',
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
  return [createServiceTool(deps, gate), rootTool, tool, writeTool, deleteTool, listLocalTool, readLocalTool, uploadTool];
}
