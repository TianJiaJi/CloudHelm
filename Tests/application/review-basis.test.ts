import { expect, it, vi } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation, RiskAssessment, SafetyDecision } from '@cloudhelm/core';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'ss -K', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };

it.each(['allow', 'deny', 'review', 'error', 'human'] as const)('retains static basis through %s without changing its authority', async (answer) => {
  const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, exitCode: 0, stdoutTail: '' }));
  const evaluate = vi.fn(async (): Promise<RiskAssessment> => ({ verdict: answer === 'human' ? 'review' : answer,
    reason: 'synthetic-review-result' }));
  const requestApproval = vi.fn(async () => false);
  const decisions: SafetyDecision[] = [];
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate }, approvals: { requestApproval },
    executor: { execute }, lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    independentReview: () => true,
    settings: () => ({ mode: answer === 'human' ? 'ask' : 'ai-review', revision: 1 }),
    audit: { proposed: async () => {}, completed: async () => {}, decided: async (_id, decision) => { decisions.push(decision); } } });
  const result = await gate.execute(operation);
  expect(result.decision.reason).toContain('[unsupported-query-form]');
  expect(decisions.at(-1)?.reason).toContain('[unsupported-query-form]');
  expect(execute).toHaveBeenCalledTimes(answer === 'allow' ? 1 : 0);
  expect(evaluate).toHaveBeenCalledTimes(answer === 'human' ? 0 : 1);
  expect(requestApproval).toHaveBeenCalledTimes(['review', 'error', 'human'].includes(answer) ? 1 : 0);
  if (answer === 'review' || answer === 'error') {
    expect(result.decision.ruleId).toBe('human-denied');
    expect(result.decision.reason).toContain(answer === 'error' ? '[ai-review-unavailable]' : '[ai-review-uncertain]');
    expect(result.decision.reason).toContain('synthetic-review-result');
  }
});
