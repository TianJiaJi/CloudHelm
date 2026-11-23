import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { processControlReviewCommand, type BusinessTool, type OperationExecutor, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { AdjudicationSchema } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { SafetyGate, TerminalManager } from '@cloudhelm/application';
import type { BackgroundOperations } from './background-operations.js';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';

const parameters = Type.Object({ hostId: Type.String({ minLength: 1, maxLength: 128 }),
  jobId: Type.String({ minLength: 1, maxLength: 128 }),
  adjudications: Type.Optional(Type.Array(AdjudicationSchema, { maxItems: 8 })) }, { additionalProperties: false });

/** Model can name an owned job, not a PID, process group, identity or signal. */
export function createBackgroundJobTool(deps: {
  background: BackgroundOperations; terminal: TerminalManager; executor: OperationExecutor;
  hosts: RuntimeHost[]; operations(): OperationView[]; assertActive(): void;
  scope: RemoteToolDependencies['scope']; runOperation: RemoteToolDependencies['runOperation'];
  createGate(executor: OperationExecutor): SafetyGate;
}): BusinessTool<Static<typeof parameters>> {
  return { name: 'stop_remote_job', label: 'Request a reviewed background-job stop', replay: 'never', parameters,
    description: 'Request SIGINT for one owned, currently observed background job through SafetyGate. Only hostId/jobId are accepted; PID or arbitrary shell stay outside the accepted inputs. Signal acknowledgement is NOT process exit. Query the original operation/job and read its log afterwards. Unknown/disconnected or changed bindings require inspection; automatic resend and identity fallback stay blocked.',
    execute: async (_id, { hostId, jobId, adjudications }, signal) => {
      deps.assertActive(); signal?.throwIfAborted();
      const host = deps.hosts.find((entry) => entry.id === hostId), job = deps.background.get(jobId);
      if (!host || !job || job.hostId !== hostId) throw new Error('Background job outside this conversation authorization');
      if (job.stopRequestId || job.exitObserved || job.notStarted) return {
        content: [{ type: 'text', text: JSON.stringify({ executionJob: job, signalSent: false, reason: 'Already requested or terminal; no new signal sent' }) }],
        details: { executionJob: job }, isError: false };
      if (job.status !== 'running' || !job.pid || !deps.background.hasLease(job.terminalId))
        throw new Error('Background process is not currently controllable; inspect without replay');
      const target = deps.operations().find((operation) => operation.id === job.operationId && operation.taskId === job.taskId);
      if (!target?.commandSource?.cwd) throw new Error('Background working-directory binding unavailable');
      const scope = deps.scope(host, job.terminalId, target.commandSource.cwd);
      if (scope.taskId !== job.taskId || scope.hostId !== job.hostId || scope.terminalGeneration !== job.terminalGeneration
        || (scope.loginAs ?? scope.runAs) !== job.loginAs) throw new Error('Background identity or terminal generation changed');
      const control = { kind: 'interrupt' as const, jobId, targetOperationId: job.operationId,
        pid: job.pid, processSequence: job.processSequence, connectionId: job.connectionId };
      const operation: ProposedOperation = { id: randomUUID(), kind: 'command', command: processControlReviewCommand(control),
        processControl: control, delegationId: randomUUID(), toolCallId: _id,
        ...(adjudications ? { adjudications } : {}), scope };
      const executor: OperationExecutor = { execute: async (reviewed, fingerprint, executionSignal, options) => {
        executionSignal?.throwIfAborted();
        if (reviewed.id !== operation.id || reviewed.kind !== 'command' || !reviewed.processControl
          || !options?.isAuthorized?.()) throw new Error('Stop operation authorization expired');
        if (deps.executor.canControlOperation?.(hostId, job.operationId) !== true) return {
          operationId: reviewed.id, status: 'failed', effects: 'none', failureKind: 'unresolved-prior-operation',
          stdoutTail: '停止信号未发送：主机存在其他运行或未知操作，不能绕过其写锁。请先核验。' };
        return deps.background.interrupt(reviewed,
          () => deps.terminal.interruptOperation(reviewed, fingerprint, () => !executionSignal?.aborted && options.isAuthorized!()));
      } };
      return deps.runOperation(deps.createGate(executor), operation, signal, host.label);
    }
  };
}
