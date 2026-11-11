import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { LocalFileAccess } from './local-file-access.js';

export interface RemoteFileSnapshot { content: string; bytes: number; truncated: boolean; sha256?: string;
  mode: number; uid: number; gid: number }

export interface RemoteToolDependencies {
  hosts: RuntimeHost[];
  localFiles: LocalFileAccess;
  /** Bounded SFTP read for the edit loop; sha256 exists only for a complete read. */
  readRemoteFile?(hostId: string, path: string, cwd: string | undefined, signal?: AbortSignal): Promise<RemoteFileSnapshot>;
  background?(signal: AbortSignal | undefined, run: (signal: AbortSignal) => ReturnType<RemoteToolDependencies['runOperation']>): ReturnType<RemoteToolDependencies['runOperation']>;
  ensureTerminal(hostId: string, sessionId?: string): Promise<string>;
  requestRoot?(host: RuntimeHost, command: string, cwd: string, reason: string, signal?: AbortSignal, method?: import('@cloudhelm/core').PrivilegeMethod): Promise<unknown>;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
  runOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined, hostLabel: string): Promise<{ result?: import('@cloudhelm/core').OperationResult; readOnly?: boolean; content: Array<{ type: 'text'; text: string }>; details: unknown; structuredContent?: unknown; isError: boolean }>;
}
