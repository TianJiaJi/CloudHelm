import { expect, it, vi } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { SafetyGate } from '@cloudhelm/application';
import type { OperationImpact, ProposedOperation, RiskEvaluator, SafetyDecision } from '@cloudhelm/core';

it.each([
  ['docker build .', 'code-execution'], ['rsync ./public host:/srv/public', 'external-transfer'], ['npm install', 'project-code-entry']
])('keeps impact, review basis and final audit consistent without dispatch on refusal: %s', async (command, ruleId) => {
  const operation: ProposedOperation = { id: 'op', kind: 'command', command, scope: { taskId: 'task', hostId: 'host',
    cwd: '/srv/app', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1,
    allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'maintain application' } };
  for (const mode of ['ask', 'ai-review'] as const) {
    const execute = vi.fn(), requestApproval = vi.fn(async () => false);
    let classified: OperationImpact | undefined;
    const evaluate = vi.fn(async (...[_op, _analysis, context]: Parameters<RiskEvaluator['evaluate']>) => {
      expect(context?.classification).toMatchObject({ ruleId, verdict: 'evaluate' });
      expect(context?.impactAnalysis).toEqual(classified);
      return 'deny' as const;
    });
    const decisions: SafetyDecision[] = [];
    const gate = new SafetyGate({ analyzer: new BashAnalyzer(), executor: { execute }, evaluator: { evaluate },
      approvals: { requestApproval }, settings: () => ({ mode, revision: 1 }),
      lease: { currentGeneration: () => 1, isAgentOwner: () => true }, audit: { proposed: async () => {},
        classified: async (_id, readOnly, impact) => { expect(readOnly).toBe(false); classified = impact; },
        decided: async (_id, decision) => { decisions.push(decision); }, completed: vi.fn() } });
    const outcome = await gate.execute(operation);
    expect(outcome.decision).toMatchObject({ verdict: 'deny', ruleId: mode === 'ask' ? 'human-denied' : 'ai-review-deny' });
    expect(outcome.decision.reason).toContain(ruleId);
    expect(decisions).toEqual([outcome.decision]);
    expect(classified?.mutation).toBe('possible');
    expect(execute).not.toHaveBeenCalled();
    if (mode === 'ask') {
      expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ ruleId, impact: 'unknown' }));
      expect(evaluate).not.toHaveBeenCalled();
    } else { expect(evaluate).toHaveBeenCalledOnce(); expect(requestApproval).not.toHaveBeenCalled(); }
  }
});
