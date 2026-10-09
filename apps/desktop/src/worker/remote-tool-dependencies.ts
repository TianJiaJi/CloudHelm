import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope, ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { LocalFileAccess } from './local-file-access.js';

export interface RemoteToolDependencies {
  hosts: RuntimeHost[];
  localFiles: LocalFileAccess;
  ensureTerminal(hostId: string, sessionId?: string): Promise<string>;
  requestRoot?(host: RuntimeHost, command: string, cwd: string, reason: string, signal?: AbortSignal): Promise<unknown>;
  scope(host: RuntimeHost, terminalId: string, cwd?: string): OperationScope;
  runOperation(gate: SafetyGate, operation: ProposedOperation, signal: AbortSignal | undefined, hostLabel: string): Promise<{ result?: import('@cloudhelm/core').OperationResult; content: Array<{ type: 'text'; text: string }>; details: undefined; isError: boolean }>;
}
