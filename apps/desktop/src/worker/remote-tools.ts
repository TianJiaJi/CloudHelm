import { createHash, randomUUID } from 'node:crypto';
import type { BusinessTool } from '@cloudhelm/core';
import { Type, type Static } from 'typebox';
import { createSelectedReadTool } from '@cloudhelm/adapters';
import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { LocalFileAccess } from './local-file-access.js';

interface Dependencies {
  hosts: RuntimeHost[];
  localFiles: LocalFileAccess;
  ensureTerminal(hostId: string, sessionId?: string): Promise<string>;
  requestRoot?(host: RuntimeHost, command: string, cwd: string, reason: string, signal?: AbortSignal): Promise<unknown>;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
  runOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined, hostLabel: string): Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined; isError: boolean }>;
}
function outOfScope() {
  return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }], details: undefined, isError: true };
}
export function createRemoteTools(deps: Dependencies, gate: SafetyGate) {
    const parameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) });
    const tool: BusinessTool<Static<typeof parameters>> = {
      name: 'run_remote', label: 'Execute an audited remote SSH command',
      description: 'Perform one logical action on an authorized host. Do not chain independent actions or print decorative separators. Use cwd instead of cd prefixes. Commands are shown in its dedicated real SSH terminal after safety review. Use absolute paths when possible. Pass sessionId only for a confirmed root session.',
      parameters,
      replay: 'never',
      execute: async (_id, params, signal) => {
        const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
        if (!host) return outOfScope();
        const terminalId = await deps.ensureTerminal(host.id, params.sessionId);
        const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command: params.command,
          scope: deps.scope(host, terminalId, params.cwd) };
        return deps.runOperation(gate, operation, signal, host.label);
      }
    };
    const writeParameters = Type.Object({ hostId: Type.String(), path: Type.String(), content: Type.String(), cwd: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()) });
    const writeTool: BusinessTool<Static<typeof writeParameters>> = {
      name: 'write_remote_file', label: 'Write an audited remote file',
      description: 'Write a UTF-8 file over SFTP on an authorized host. Existing regular files receive a private recovery copy. Maximum 1 MiB. Parent directory must exist. sessionId may select a root SSH session; su sessions do not elevate SFTP.',
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
    const listLocalParameters = Type.Object({ path: Type.String() });
    const listLocalTool: BusinessTool<Static<typeof listLocalParameters>> = {
      name: 'list_selected_directory', label: 'List a selected local directory',
      description: 'List at most 200 entries inside a directory explicitly selected by the user. Use absolute paths.',
      parameters: listLocalParameters, replay: 'never',
      execute: async (_id, params) => {
        try { return { content: [{ type: 'text', text: JSON.stringify(await deps.localFiles.list(params.path)) }], details: undefined }; }
        catch (error) { return { content: [{ type: 'text', text: String(error) }], details: undefined, isError: true }; }
      }
    };
    const readLocalTool = createSelectedReadTool((path) => deps.localFiles.read(path));
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
          const { data, scope } = await deps.localFiles.read(params.localPath);
          return deps.runOperation(gate, { id: randomUUID(), kind: 'upload', localPath: params.localPath,
            localRoot: scope.path, remotePath: params.remotePath, size: data.length,
            contentSha256: createHash('sha256').update(data).digest('hex'),
            scope: deps.scope(host, terminalId, params.cwd) }, signal, host.label);
        } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], details: undefined, isError: true }; }
      }
    };
  const rootParameters = Type.Object({ hostId: Type.String(), command: Type.String(), cwd: Type.String(), reason: Type.String() });
  const rootTool: BusinessTool<Static<typeof rootParameters>> = {
    name: 'request_root_session', label: 'Request a confirmed root session',
    description: 'When sudo is unavailable, request user confirmation for an isolated root SSH or su session. Supply the intended operation and reason. This only verifies identity; it does not execute the intended command. Wait for the returned sessionId before any dependent calls. Never use this after a denied review or canceled/failed authentication.',
    parameters: rootParameters, replay: 'never',
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
      if (!host) return outOfScope();
      if (!deps.requestRoot) throw new Error('Root sessions unavailable');
      const session = await deps.requestRoot(host, params.command, params.cwd, params.reason, signal);
      return { content: [{ type: 'text', text: JSON.stringify(session) }], details: undefined };
    }
  };
  return [rootTool, tool, writeTool, deleteTool, listLocalTool, readLocalTool, uploadTool];
}
