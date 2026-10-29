import { describe, expect, it, vi } from 'vitest';
import type { CommandAnalysis, OperationResult, ProposedOperation, ReviewMode } from '@cloudhelm/core';
import { SafetyGate } from '../../packages/application/src/safety-gate.js';

const operation: ProposedOperation = { id: 'query', kind: 'command', command: 'docker images', scope: {
  taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: '列出镜像'
} };
function setup(result: Omit<OperationResult, 'operationId'>, mode: ReviewMode = 'ask', query = true) {
  const analysis: CommandAnalysis = { raw: operation.kind === 'command' ? operation.command : '',
    calls: [{ name: query ? 'docker' : 'touch', args: query ? ['images'] : ['/tmp/file'], dynamic: false, redirects: false }],
    hasError: false, hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, redirectTargets: [] };
  const analyze = vi.fn(async () => analysis);
  const classified = vi.fn(async () => {});
  const completed = vi.fn(async () => {});
  const execute = vi.fn(async () => ({ operationId: operation.id, ...result }));
  const requestApproval = vi.fn(async () => true);
  let generation = 1;
  const gate = new SafetyGate({ analyzer: { analyze }, executor: { execute },
    approvals: { requestApproval }, evaluator: { evaluate: async () => 'allow' },
    audit: { proposed: async () => {}, classified, decided: async () => {}, completed },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true }, settings: () => ({ mode, revision: 1 }) });
  return { gate, analyze, classified, completed, execute, requestApproval, revoke: () => { generation++; } };
}

describe('authoritative query effects', () => {
  it.each(['ask', 'ai-review', 'permissive'] as const)('propagates the same query capability in %s mode', async (mode) => {
    const f = setup({ status: 'failed', exitCode: 1, effects: 'possible', failureKind: 'permission-denied', stdoutTail: 'permission denied' }, mode);
    const outcome = await f.gate.execute(operation);
    expect(f.analyze).toHaveBeenCalledOnce();
    expect(f.classified).toHaveBeenCalledWith(operation.id, true);
    expect(f.execute).toHaveBeenCalledWith(expect.anything(), expect.any(String), undefined,
      expect.objectContaining({ readOnly: true, isAuthorized: expect.any(Function) }));
    expect(outcome.result).toMatchObject({ status: 'failed', exitCode: 1, effects: 'none', failureKind: 'permission-denied' });
    expect(f.completed).toHaveBeenCalledWith(outcome.result);
    expect(f.requestApproval).not.toHaveBeenCalled();
  });

  it('does not turn a failed mutation with permission denial into a harmless query', async () => {
    const f = setup({ status: 'failed', exitCode: 1, effects: 'possible', failureKind: 'permission-denied', stdoutTail: 'permission denied' }, 'ask', false);
    const outcome = await f.gate.execute({ ...operation, command: 'touch /tmp/file' });
    expect(f.classified).toHaveBeenCalledWith(operation.id, false);
    expect(outcome.result?.effects).toBe('possible');
  });

  it.each([
    { status: 'unknown' as const, effects: 'possible' as const },
    { status: 'handed-over' as const, effects: 'possible' as const },
    { status: 'failed' as const, effects: 'possible' as const }
  ])('does not claim a known exit for $status without exit evidence', async (result) => {
    const f = setup({ ...result, stdoutTail: '' });
    expect((await f.gate.execute(operation)).result).toMatchObject(result);
  });

  it('preserves private authentication stops even for a query', async () => {
    const f = setup({ status: 'failed', exitCode: 1, effects: 'possible', stdoutTail: '',
      authentication: 'failed', failureKind: 'authentication-failed', requiresUserAction: true });
    expect((await f.gate.execute(operation)).result).toMatchObject({ status: 'failed', effects: 'none',
      authentication: 'failed', failureKind: 'authentication-failed', requiresUserAction: true });
  });

  it('still refuses a stale terminal lease', async () => {
    const f = setup({ status: 'succeeded', exitCode: 0, stdoutTail: '' });
    f.revoke();
    expect((await f.gate.execute(operation)).decision.ruleId).toBe('authorization-expired');
    expect(f.execute).not.toHaveBeenCalled();
  });
});
