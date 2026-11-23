import { describe, expect, it, vi } from 'vitest';
import { SafetyGate } from '../../packages/application/src/safety-gate.js';
import { AdjudicationRegistry } from '../../packages/application/src/adjudication-registry.js';
import { verifyAdjudicationReproposal } from '../../packages/application/src/review-execution.js';
import type { ApprovalRequest, OperationScope, ProposedOperation } from '@cloudhelm/core';

const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user',
  terminalId: 'pty', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: '检查服务' };
const operation: ProposedOperation = { id: 'op-1', kind: 'command', command: 'customctl inspect', scope };

function fixture(options: { independentReview?: boolean } = {}) {
  const registry = new AdjudicationRegistry();
  const evaluate = vi.fn(async () => 'allow' as const);
  const requestApproval = vi.fn(async (_request: ApprovalRequest) => false);
  const execute = vi.fn(async () => ({ operationId: 'op-1', status: 'succeeded' as const, exitCode: 0, stdoutTail: '' }));
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'customctl', args: ['inspect'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate }, approvals: { requestApproval }, executor: { execute },
    adjudications: registry,
    ...(options.independentReview ? { independentReview: () => true } : {}),
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true },
    settings: () => ({ mode: 'ai-review', revision: 1 })
  });
  return { gate, registry, evaluate, requestApproval, execute };
}

describe('self-adjudication protocol', () => {
  it('mints a deterministic receipt before any dispatch without consulting the reviewer', async () => {
    const f = fixture();
    const outcome = await f.gate.execute(operation);
    expect(outcome.decision).toMatchObject({ verdict: 'evaluate', ruleId: 'adjudication-required' });
    expect(outcome.result).toBeUndefined();
    expect(outcome.decision.adjudication).toMatchObject({ id: expect.any(String), expiresAt: expect.any(Number) });
    expect(outcome.decision.adjudication?.expiresAt).toBeGreaterThan(Date.now());
    expect(outcome.decision.reason).toContain(outcome.decision.adjudication!.id);
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('reuses the pending receipt for an identical re-proposal', async () => {
    const f = fixture();
    const first = await f.gate.execute({ ...operation, id: 'a' });
    const second = await f.gate.execute({ ...operation, id: 'b' });
    expect(second.decision.ruleId).toBe('adjudication-required');
    expect(second.decision.adjudication?.id).toBe(first.decision.adjudication?.id);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('dispatches only after an explicit same-model confirmation', async () => {
    const f = fixture();
    const receipt = await f.gate.execute(operation);
    const confirmed = await f.gate.execute({ ...operation, id: 're-proposal', adjudications: [{
      adjudicationId: receipt.decision.adjudication!.id, confirmed: true, basis: ['用户在任务目标中明确要求检查该服务'] }] });
    expect(confirmed.decision).toMatchObject({ verdict: 'allow', ruleId: 'self-adjudication-confirmed' });
    expect(confirmed.decision.reason).toContain('用户在任务目标中明确要求检查该服务');
    expect(confirmed.result?.status).toBe('succeeded');
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
  });

  it('never reauthorizes a consumed receipt', async () => {
    const f = fixture();
    const receipt = await f.gate.execute(operation);
    const confirmation = { adjudicationId: receipt.decision.adjudication!.id, confirmed: true, basis: ['确认执行'] };
    await f.gate.execute({ ...operation, adjudications: [confirmation] });
    const replay = await f.gate.execute({ ...operation, adjudications: [confirmation] });
    expect(replay.decision.verdict).toBe('deny');
    expect(f.requestApproval).toHaveBeenCalledOnce();
    expect(f.requestApproval.mock.calls[0]![0].reason).toContain('already-consumed');
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('ignores entries bound to other operations and mints their own receipt', async () => {
    const f = fixture();
    const inspect = await f.gate.execute(operation);
    const status = await f.gate.execute({ ...operation, command: 'customctl status', adjudications: [{
      adjudicationId: inspect.decision.adjudication!.id, confirmed: true, basis: ['属于另一操作的确认'] }] });
    expect(status.decision.ruleId).toBe('adjudication-required');
    expect(status.decision.adjudication?.id).not.toBe(inspect.decision.adjudication?.id);
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('escalates a declined confirmation to a human and denies the binding permanently', async () => {
    const f = fixture();
    const receipt = await f.gate.execute(operation);
    const declined = await f.gate.execute({ ...operation, adjudications: [{
      adjudicationId: receipt.decision.adjudication!.id, confirmed: false, basis: ['放弃该操作'] }] });
    expect(declined.decision.verdict).toBe('deny');
    expect(f.requestApproval.mock.calls[0]![0].reason).toContain('declined');
    const revived = await f.gate.execute({ ...operation, adjudications: [{
      adjudicationId: receipt.decision.adjudication!.id, confirmed: true, basis: ['重新确认'] }] });
    expect(revived.decision.verdict).toBe('deny');
    expect(f.requestApproval.mock.calls[1]![0].reason).toContain('binding-denied');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('escalates a malformed confirmation to a human', async () => {
    const f = fixture();
    const receipt = await f.gate.execute(operation);
    const malformed = await f.gate.execute({ ...operation, adjudications: [{
      adjudicationId: receipt.decision.adjudication!.id, confirmed: true, basis: [] }] });
    expect(malformed.decision.verdict).toBe('deny');
    expect(f.requestApproval).toHaveBeenCalledOnce();
    expect(f.requestApproval.mock.calls[0]![0].reason).toContain('invalid-adjudication');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('escalates a late confirmation after the receipt expired', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    try {
      const f = fixture();
      const receipt = await f.gate.execute(operation);
      now.mockReturnValue(receipt.decision.adjudication!.expiresAt + 1);
      const late = await f.gate.execute({ ...operation, adjudications: [{
        adjudicationId: receipt.decision.adjudication!.id, confirmed: true, basis: ['迟到确认'] }] });
      expect(late.decision.verdict).toBe('deny');
      expect(f.requestApproval).toHaveBeenCalledOnce();
      expect(f.requestApproval.mock.calls[0]![0].reason).toContain('expired');
      expect(f.execute).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it('keeps the configured independent reviewer on the review port', async () => {
    const f = fixture({ independentReview: true });
    const outcome = await f.gate.execute(operation);
    expect(f.evaluate).toHaveBeenCalledOnce();
    expect(outcome.decision).toMatchObject({ verdict: 'allow', ruleId: 'ai-review-allow' });
    expect(outcome.decision.adjudication).toBeUndefined();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.requestApproval).not.toHaveBeenCalled();
  });
});

describe('AdjudicationRegistry', () => {
  it('reuses a pending receipt and never remints a terminal one', () => {
    const registry = new AdjudicationRegistry();
    const first = registry.pending('fingerprint', 'task', 'host', 1);
    expect(registry.pending('fingerprint', 'task', 'host', 2).id).toBe(first.id);
    expect(registry.consume(first.id)).toBe(true);
    expect(registry.consume(first.id)).toBe(false);
    expect(registry.pending('fingerprint', 'task', 'host', 3).id).not.toBe(first.id);
  });

  it('evicts terminal records first, then the oldest, at capacity', () => {
    const registry = new AdjudicationRegistry();
    const consumed = registry.pending('consumed', 'task', 'host', 1);
    registry.consume(consumed.id);
    const ids: string[] = [];
    for (let index = 0; index < 16; index++) ids.push(registry.pending(`fingerprint-${index}`, 'task', 'host', 2).id);
    expect(registry.find(consumed.id)).toBeUndefined();
    const extra = registry.pending('extra', 'task', 'host', 3);
    expect(registry.find(ids[0]!)).toBeUndefined();
    expect(registry.find(extra.id)?.fingerprint).toBe('extra');
  });

  it('drops expired pending receipts on the next mint', () => {
    const registry = new AdjudicationRegistry();
    const stale = registry.pending('stale', 'task', 'host', 0);
    const fresh = registry.pending('fresh', 'task', 'host', 10 * 60_000 + 1);
    expect(registry.find(stale.id)).toBeUndefined();
    expect(registry.find(fresh.id)?.fingerprint).toBe('fresh');
  });
});

describe('verifyAdjudicationReproposal', () => {
  it('escalates a scope mismatch defensively', () => {
    const registry = new AdjudicationRegistry();
    const binding = registry.pending('fingerprint', 'other-task', 'other-host');
    const verification = verifyAdjudicationReproposal({ ...operation, adjudications: [{
      adjudicationId: binding.id, confirmed: true, basis: ['越界确认'] }] }, 'fingerprint', registry);
    expect(verification).toMatchObject({ kind: 'escalate', cause: 'scope-mismatch' });
    expect(registry.find(binding.id)?.state).toBe('denied');
  });

  it('treats an expired pending receipt as escalation, not silent re-mint', () => {
    const registry = new AdjudicationRegistry();
    const binding = registry.pending('fingerprint', 'task', 'host', 1_000);
    const verification = verifyAdjudicationReproposal({ ...operation, adjudications: [{
      adjudicationId: binding.id, confirmed: true, basis: ['过期确认'] }] }, 'fingerprint', registry, binding.expiresAt + 1);
    expect(verification).toMatchObject({ kind: 'escalate', cause: 'expired' });
    expect(registry.find(binding.id)?.state).toBe('denied');
  });
});
