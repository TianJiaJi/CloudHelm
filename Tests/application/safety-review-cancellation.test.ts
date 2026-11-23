import { afterEach, expect, it, vi } from 'vitest';
import { SafetyGate } from '@cloudhelm/application';
import { ReviewInterruptedError, type ProposedOperation, type RiskAssessment, type RiskEvaluator, type SafetyDecision } from '@cloudhelm/core';

afterEach(() => vi.useRealTimers());
const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'customctl inspect', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, reviewerRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' } };
function fixture() {
  let finish!: (value: RiskAssessment) => void;
  let fail!: (error: Error) => void;
  const response = new Promise<RiskAssessment>((resolve, reject) => { finish = resolve; fail = reject; });
  const evaluate = vi.fn< RiskEvaluator['evaluate'] >(() => response);
  const execute = vi.fn(), requestApproval = vi.fn(async () => false);
  const lifetime = new AbortController();
  let revision = 1;
  const decisions: SafetyDecision[] = [];
  const gate = new SafetyGate({ analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'customctl', args: ['inspect'],
    dynamic: false, redirects: false }], redirectTargets: [], hasError: false, hasExpansion: false,
    hasCompound: false, hasRedirection: false, hasPipeline: false }) }, evaluator: { evaluate }, executor: { execute },
    approvals: { requestApproval }, reviewSignal: () => lifetime.signal,
    independentReview: () => true,
    settings: () => ({ mode: 'ai-review', revision, reviewerRevision: 1 }),
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, audit: { proposed: async () => {}, completed: vi.fn(),
      decided: async (_id, decision) => { decisions.push(decision); } } });
  return { gate, evaluate, execute, requestApproval, lifetime, decisions, finish, fail, stale: () => { revision++; } };
}

it('cancels a noncooperative reviewer promptly and ignores its late allow', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.gate.execute(operation, controller.signal);
  await vi.waitFor(() => expect(f.evaluate).toHaveBeenCalledOnce());
  const signal = f.evaluate.mock.calls[0]![3];
  controller.abort();
  expect(signal?.aborted).toBe(true);
  expect((await pending).decision.ruleId).toBe('review-canceled');
  f.evaluate.mockResolvedValue({ verdict: 'deny' });
  expect((await f.gate.execute(operation)).decision.ruleId).toBe('ai-review-deny');
  f.finish({ verdict: 'allow' }); await Promise.resolve();
  expect(f.decisions).toHaveLength(2); expect(f.decisions[1]!.ruleId).toBe('ai-review-deny');
  expect(f.execute).not.toHaveBeenCalled(); expect(f.requestApproval).not.toHaveBeenCalled();
});

it('does not invoke review or approval for an already-canceled operation', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect((await f.gate.execute(operation, controller.signal)).decision.ruleId).toBe('review-canceled');
  expect(f.evaluate).not.toHaveBeenCalled(); expect(f.requestApproval).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it.each(['allow', 'deny', 'review', 'error'] as const)('discards a stale reviewer response (%s), including a stale rejection', async (verdict) => {
  const f = fixture(), pending = f.gate.execute(operation);
  await vi.waitFor(() => expect(f.evaluate).toHaveBeenCalledOnce());
  f.stale(); f.finish({ verdict });
  expect((await pending).decision.ruleId).toBe('authorization-expired');
  expect(f.execute).not.toHaveBeenCalled(); expect(f.requestApproval).not.toHaveBeenCalled();
  expect(f.decisions).toHaveLength(1); expect(f.decisions[0]!.reason).toContain('[uncertain-command]');
});

it('aborts on a reviewer lifetime change even when the operation signal is still active', async () => {
  const f = fixture(), pending = f.gate.execute(operation);
  await vi.waitFor(() => expect(f.evaluate).toHaveBeenCalledOnce());
  const signal = f.evaluate.mock.calls[0]![3];
  f.lifetime.abort();
  expect(signal?.aborted).toBe(true);
  expect((await pending).decision.ruleId).toBe('authorization-expired');
  f.fail(new Error('late transport rejection')); await Promise.resolve();
  expect(f.decisions).toHaveLength(1); expect(f.requestApproval).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it.each(['stale', 'canceled'] as const)('revokes an old human escalation on %s without accepting its late approval', async (outcome) => {
  const f = fixture(); let approve!: (value: boolean) => void;
  f.evaluate.mockResolvedValue({ verdict: 'review' });
  f.requestApproval.mockImplementation(() => new Promise((resolve) => { approve = resolve; }));
  const pending = f.gate.execute(operation);
  await vi.waitFor(() => expect(f.requestApproval).toHaveBeenCalledOnce());
  f.lifetime.abort(new ReviewInterruptedError(outcome));
  expect((await pending).decision.ruleId).toBe(outcome === 'stale' ? 'authorization-expired' : 'review-canceled');
  approve(true); await Promise.resolve();
  expect(f.execute).not.toHaveBeenCalled(); expect(f.decisions).toHaveLength(1);
});

it('times out a noncooperative review, aborts its request and requires explicit human approval', async () => {
  const f = fixture(); vi.useFakeTimers();
  const pending = f.gate.execute(operation);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluate).toHaveBeenCalledOnce();
  const signal = f.evaluate.mock.calls[0]![3];
  await vi.advanceTimersByTimeAsync(30_000);
  expect(signal?.aborted).toBe(true);
  expect((await pending).decision).toMatchObject({ verdict: 'deny', ruleId: 'human-denied' });
  expect(f.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'ai-review-timeout' }));
  expect(vi.getTimerCount()).toBe(0);
  f.finish({ verdict: 'allow' }); await Promise.resolve();
  expect(f.execute).not.toHaveBeenCalled(); expect(f.decisions).toHaveLength(1);
});
