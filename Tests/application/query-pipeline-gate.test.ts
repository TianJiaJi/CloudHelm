import { expect, it, vi } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';

it.each(['audit-failure', 'stale-policy'])('does not dispatch an auto-approved query pipeline after %s', async (failure) => {
  const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'ss -ltnp | grep -F nginx', scope: {
    taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };
  let revision = 1;
  const execute = vi.fn(), evaluate = vi.fn(), requestApproval = vi.fn();
  const gate = new SafetyGate({ analyzer: new BashAnalyzer(), evaluator: { evaluate }, approvals: { requestApproval },
    executor: { execute }, settings: () => ({ mode: 'ask', revision }),
    lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    audit: { proposed: async () => {}, completed: async () => {}, decided: async (_id, decision) => {
      if (decision.verdict !== 'allow') return;
      if (failure === 'audit-failure') throw new Error('synthetic-audit-failure');
      revision = 2;
    } } });
  const pending = gate.execute(operation);
  if (failure === 'audit-failure') await expect(pending).rejects.toThrow('synthetic-audit-failure');
  else expect((await pending).decision).toMatchObject({ verdict: 'error', ruleId: 'authorization-expired' });
  expect(execute).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled(); expect(requestApproval).not.toHaveBeenCalled();
});
