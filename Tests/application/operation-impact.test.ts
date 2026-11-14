import { expect, it, vi } from 'vitest';
import { SafetyGate } from '@cloudhelm/application';
import { BashAnalyzer } from '@cloudhelm/adapters';
import type { ExecutionOptions, OperationImpact, ProposedOperation, RiskEvaluator } from '@cloudhelm/core';

it('shares fixed facts with audit and executor without granting authority from mutable metadata', async () => {
  const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'df -h', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };
  let observed: OperationImpact | undefined;
  const execute = vi.fn(async (_operation: ProposedOperation, _fingerprint: string, _signal?: AbortSignal, options?: ExecutionOptions) => {
    expect(options?.isAuthorized?.()).toBe(true); expect(options?.readOnly).toBe(true);
    expect(options?.impactAnalysis?.mutation).toBe('none');
    return { operationId: 'op', status: 'succeeded' as const, exitCode: 0, stdoutTail: '' };
  });
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: { execute },
    evaluator: { evaluate: vi.fn() }, approvals: { requestApproval: vi.fn() }, settings: () => ({ mode: 'ask', revision: 1 }),
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, audit: { proposed: async () => {},
      classified: async (_id, readOnly, impact) => { expect(readOnly).toBe(true); observed = structuredClone(impact!); impact!.mutation = 'possible'; },
      decided: async () => {}, completed: async () => {} } });
  await gate.execute(operation);
  expect(observed).toMatchObject({ version: 1, mutation: 'none', evidence: 'query-proof' });
  expect(execute).toHaveBeenCalledOnce();
});

it('supplies the same impact dimensions to independent review without changing a denial into execution', async () => {
  const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'python3 -c "print(1)"', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };
  const execute = vi.fn(), requestApproval = vi.fn();
  const evaluate = vi.fn(async (...args: Parameters<RiskEvaluator['evaluate']>) => {
    expect(args[2]?.impactAnalysis).toMatchObject({ version: 1, mutation: 'possible', codeExecution: 'detected', externalTransfer: 'unknown' });
    return 'deny' as const;
  });
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: { execute }, evaluator: { evaluate },
    approvals: { requestApproval }, settings: () => ({ mode: 'ai-review', revision: 1 }),
    lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} } });
  expect((await gate.execute(operation)).decision.ruleId).toBe('ai-review-deny');
  expect(evaluate).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(requestApproval).not.toHaveBeenCalled();
});
