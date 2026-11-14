import { afterEach, expect, it, vi } from 'vitest';
import { SafetyGate } from '@cloudhelm/application';
import { ApprovalInterruptedError, type ProposedOperation, type SafetyDecision } from '@cloudhelm/core';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'customctl inspect', scope: {
  taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };
afterEach(() => vi.useRealTimers());
function setup(cleanupFails = false) {
  vi.useFakeTimers();
  let reply!: (approved: boolean) => void;
  const requestApproval = vi.fn(() => new Promise<boolean>((resolve) => { reply = resolve; }));
  const cancelApproval = vi.fn(() => { if (cleanupFails) throw new Error('synthetic-private-cleanup-detail'); });
  const execute = vi.fn(), decisions: SafetyDecision[] = [];
  const gate = new SafetyGate({ analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'customctl', args: ['inspect'],
    dynamic: false, redirects: false }], redirectTargets: [], hasExpansion: false, hasPipeline: false,
    hasCompound: false, hasRedirection: false, hasError: false }) }, evaluator: { evaluate: vi.fn() },
    approvals: { requestApproval, cancelApproval }, executor: { execute },
    settings: () => ({ mode: 'ask', revision: 1 }), lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    audit: { proposed: async () => {}, completed: async () => {}, decided: async (_id, value) => { decisions.push(value); } } });
  return { gate, requestApproval, cancelApproval, execute, decisions, reply: (approved: boolean) => reply(approved) };
}

it.each(['abort', 'timeout'] as const)('records %s distinctly, cleans once and ignores late approval', async (kind) => {
  const f = setup(), controller = new AbortController();
  const pending = f.gate.execute(operation, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.requestApproval).toHaveBeenCalledOnce();
  if (kind === 'abort') controller.abort(); else await vi.advanceTimersByTimeAsync(600000);
  const result = await pending;
  expect(result.decision.ruleId).toBe(kind === 'abort' ? 'review-canceled' : 'approval-expired');
  expect(result.decision.reason).toContain('[unrecognized-operation]');
  f.reply(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.execute).not.toHaveBeenCalled(); expect(f.cancelApproval).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['approve', 'abort', 'timeout'] as const)('fails closed and audits cleanup failure after %s without hanging', async (kind) => {
  const f = setup(true), controller = new AbortController();
  const pending = f.gate.execute(operation, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  if (kind === 'approve') f.reply(true);
  else if (kind === 'abort') controller.abort();
  else await vi.advanceTimersByTimeAsync(600000);
  expect((await pending).decision.ruleId).toBe('approval-unavailable');
  expect(JSON.stringify(f.decisions)).not.toContain('synthetic-private-cleanup-detail');
  expect(f.execute).not.toHaveBeenCalled(); expect(f.cancelApproval).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['canceled', 'expired', 'stale'] as const)('does not label port interruption %s as a human refusal', async (outcome) => {
  const f = setup();
  f.requestApproval.mockRejectedValue(new ApprovalInterruptedError(outcome));
  const pending = f.gate.execute(operation);
  await vi.advanceTimersByTimeAsync(0);
  expect((await pending).decision.ruleId).toBe(outcome === 'canceled' ? 'review-canceled'
    : outcome === 'expired' ? 'approval-expired' : 'authorization-expired');
  expect(f.execute).not.toHaveBeenCalled(); expect(f.cancelApproval).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not accept a truthy non-boolean as approval', async () => {
  const f = setup(); f.requestApproval.mockResolvedValue('true' as unknown as boolean);
  const pending = f.gate.execute(operation); await vi.advanceTimersByTimeAsync(0);
  expect((await pending).decision.ruleId).toBe('approval-unavailable');
  expect(f.execute).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
