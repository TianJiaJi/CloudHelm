import type { SafetyGate } from '@cloudhelm/application';
import type { OperationScope } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';

export interface PrivilegedTaskAccess {
  request(host: RuntimeHost, command: string, cwd: string, reason: string, goal: string,
    gate: SafetyGate, signal?: AbortSignal, intent?: OperationScope['intent']): Promise<{ sessionId: string; method: 'ssh' | 'su'; runAs: 'root' }>;
  terminal(sessionId: string, hostId: string): string;
  scope(terminalId: string): Partial<OperationScope>;
  owns(terminalId: string): boolean;
  confirmed?(): Array<{ sessionId: string; hostId: string; method: 'ssh' | 'su'; runAs: 'root' }>;
  close(): void;
}
