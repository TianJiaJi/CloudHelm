import { createHash } from 'node:crypto';
import type { ProposedOperation } from './model.js';

export function operationFingerprint(operation: ProposedOperation): string {
  const { scope } = operation;
  const bound = {
    taskId: scope.taskId,
    hostId: scope.hostId,
    cwd: scope.cwd,
    runAs: scope.runAs,
    loginAs: scope.loginAs, sessionId: scope.sessionId, connectionGeneration: scope.connectionGeneration,
    terminalId: scope.terminalId,
    terminalGeneration: scope.terminalGeneration,
    policyRevision: scope.policyRevision,
    conversationRevision: scope.conversationRevision,
    reviewerRevision: scope.reviewerRevision,
    allowedWorkingRoots: scope.allowedWorkingRoots,
    protectedPaths: scope.protectedPaths,
    protectedReadPaths: scope.protectedReadPaths,
    protectedWritePaths: scope.protectedWritePaths,
    kind: operation.kind,
    payload: operation.kind === 'command' ? operation.command
      : operation.kind === 'write-file' ? [operation.path, operation.content]
      : operation.kind === 'upload' ? [operation.localPath, operation.remotePath, operation.localRoot, operation.contentSha256, operation.size]
      : operation.path
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}

/** Replay identity excludes transient approval leases; it never authorizes execution. */
export function operationIntentKey(operation: ProposedOperation): string {
  return operationFingerprint({ ...operation, scope: { ...operation.scope,
    taskId: '', terminalId: '', terminalGeneration: 0, policyRevision: 0, conversationRevision: 0, reviewerRevision: 0,
    connectionGeneration: undefined, sessionId: undefined, allowedWorkingRoots: [], protectedPaths: [],
    protectedReadPaths: [], protectedWritePaths: [], goal: ''
  } });
}
