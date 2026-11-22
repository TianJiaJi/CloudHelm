import { expect, it, vi } from 'vitest';
import type { ProposedOperation } from '@cloudhelm/core';
import { SafetyGate } from '../../packages/application/src/safety-gate.js';

it.each(['slot', 'commit'] as const)('does not dispatch an approval expiring while waiting for %s', async (phase) => {
  let now = 1_000_000, hard = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const execute = vi.fn();
  const operation: ProposedOperation = { id: 'deadline', kind: 'command', command: 'systemctl restart demo.service', scope: {
    taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'deadline contract' } };
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw,
      calls: [{ name: 'systemctl', args: ['restart', 'demo.service'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'error' },
    approvals: { requestApproval: async (request) => { hard = request.hardExpiresAt!; return true; }, cancelApproval() {} },
    audit: { proposed: async () => {}, completed: async () => {},
      decided: async (_id, decision) => { if (phase === 'commit' && decision.verdict === 'allow') now = hard; } },
    executor: { execute }, lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    settings: () => ({ mode: 'ask', revision: 1 })
  });
  try {
    const result = await gate.execute(operation, undefined, false, { withApprovalWait: async (wait) => {
      const decision = await wait();
      if (phase === 'slot') now = hard;
      return decision;
    } });
    expect(result.decision.ruleId).toBe('authorization-expired');
    expect(result.result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
