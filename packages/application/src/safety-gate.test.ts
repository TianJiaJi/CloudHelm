import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ProposedOperation } from '@cloudhelm/core';
import { SafetyGate } from './safety-gate.js';

const operation: ProposedOperation = { id: 'op', kind: 'command', command: 'python3 -c "print(1)"', scope: {
  taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'deploy', terminalId: 'pty', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Deploy service'
} };

function setup() {
  let generation = 1;
  let revision = 1;
  let approve!: (allowed: boolean) => void;
  const requestApproval = vi.fn((_request: ApprovalRequest) => new Promise<boolean>((resolve) => { approve = resolve; }));
  const execute = vi.fn().mockResolvedValue({ operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '' });
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'python3', args: ['-c', 'print(1)'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'error' }, approvals: { requestApproval }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true },
    settings: () => ({ mode: 'ai-review', revision })
  });
  return { gate, requestApproval, execute, approve: (allowed: boolean) => approve(allowed), changeGeneration: () => { generation++; }, changePolicy: () => { revision++; } };
}

describe('SafetyGate pre-commit authorization', () => {
  it('asks a human when the configured AI reviewer fails', async () => {
    const fixture = setup();
    const pending = fixture.gate.execute(operation);
    await vi.waitFor(() => expect(fixture.requestApproval).toHaveBeenCalledOnce(), { timeout: 15000 });
    fixture.approve(true);
    expect((await pending).result?.status).toBe('succeeded');
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it('invalidates pending approval after the host review policy changes', async () => {
    const fixture = setup();
    const pending = fixture.gate.execute(operation);
    await vi.waitFor(() => expect(fixture.requestApproval).toHaveBeenCalledOnce());
    fixture.changePolicy();
    fixture.approve(true);
    expect((await pending).decision.ruleId).toBe('authorization-expired');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('invalidates approval after terminal control changes', async () => {
    const fixture = setup();
    const pending = fixture.gate.execute(operation);
    await vi.waitFor(() => expect(fixture.requestApproval).toHaveBeenCalledOnce(), { timeout: 15000 });
    fixture.changeGeneration();
    fixture.approve(true);
    expect((await pending).decision.ruleId).toBe('authorization-expired');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('distinguishes a user refusal from an expired request', async () => {
    const refused = setup();
    const pendingRefusal = refused.gate.execute(operation);
    await vi.waitFor(() => expect(refused.requestApproval).toHaveBeenCalledOnce());
    refused.approve(false);
    expect((await pendingRefusal).decision.ruleId).toBe('human-denied');
    expect(refused.execute).not.toHaveBeenCalled();

    const expired = setup();
    const pendingExpiry = expired.gate.execute({ ...operation, id: 'expiry' });
    await vi.waitFor(() => expect(expired.requestApproval).toHaveBeenCalledOnce());
    const expiresAt = expired.requestApproval.mock.calls[0]![0].expiresAt;
    const now = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    try {
      expired.approve(true);
      expect((await pendingExpiry).decision.ruleId).toBe('approval-expired');
      expect(expired.execute).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });
});

it('rejects a changed inspected script before dispatch', async () => {
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => raw.startsWith('sh ') ? {
      raw, calls: [{ name: 'sh', args: ['./install.sh'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: false
    } : {
      raw, calls: [{ name: 'mkdir', args: ['/srv/app/cache'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: false
    } },
    scripts: { inspect: async () => ({ source: 'mkdir /srv/app/cache', sha256: 'old' }), verify: async () => false },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true },
    executor: { execute }, audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ask', revision: 1 })
  });
  expect((await gate.execute({ ...operation, command: 'sh ./install.sh' })).decision.ruleId).toBe('script-changed');
  expect(execute).not.toHaveBeenCalled();
});

it('does not turn an inspected script parser failure into full-access approval', async () => {
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => {
      if (!raw.startsWith('sh ')) throw new Error('WASM failure');
      return { raw, calls: [{ name: 'sh', args: ['./install.sh'], dynamic: false, redirects: false }],
        redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
        hasRedirection: false, hasError: false };
    } },
    scripts: { inspect: async () => ({ source: 'mkdir /srv/app/cache', sha256: 'sha' }), verify: async () => true },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true },
    executor: { execute }, audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  expect((await gate.execute({ ...operation, command: 'sh ./install.sh' })).decision.ruleId).toBe('analyzer-unavailable');
  expect(execute).not.toHaveBeenCalled();
});

it.each(['ask', 'ai-review', 'permissive'] as const)(
  'uses %s mode explicitly when a script cannot be read', async (mode) => {
    const approve = vi.fn(async () => false);
    const evaluate = vi.fn(async () => 'review' as const);
    const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, stdoutTail: '' }));
    const gate = new SafetyGate({
      analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'sh', args: ['./install.sh'], dynamic: false, redirects: false }],
        redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
        hasRedirection: false, hasError: false }) },
      scripts: { inspect: async () => { throw new Error('Unreadable'); }, verify: async () => true },
      evaluator: { evaluate }, approvals: { requestApproval: approve }, executor: { execute },
      audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
      lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode, revision: 1 })
    });
    const outcome = await gate.execute({ ...operation, command: 'sh ./install.sh' });
    // The ai-review tier triages an unreadable script first; only its uncertain
    // or important findings reach a human. Permissive still auto-allows opacity.
    expect(evaluate).toHaveBeenCalledTimes(mode === 'ai-review' ? 1 : 0);
    expect(approve).toHaveBeenCalledTimes(mode === 'permissive' ? 0 : 1);
    expect(execute).toHaveBeenCalledTimes(mode === 'permissive' ? 1 : 0);
    if (mode !== 'permissive') expect(outcome.decision.ruleId).toBe('human-denied');
  });

it('lets the independent reviewer auto-allow an unreadable script in ai-review mode', async () => {
  const approve = vi.fn(async () => false);
  const evaluate = vi.fn(async () => 'allow' as const);
  const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, stdoutTail: '' }));
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'sh', args: ['./install.sh'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: false }) },
    scripts: { inspect: async () => { throw new Error('Unreadable'); }, verify: async () => true },
    evaluator: { evaluate }, approvals: { requestApproval: approve }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ai-review', revision: 1 })
  });
  const outcome = await gate.execute({ ...operation, command: 'sh ./install.sh' });
  expect(evaluate).toHaveBeenCalledOnce();
  expect(approve).not.toHaveBeenCalled();
  expect(outcome.decision.ruleId).toBe('ai-review-allow');
  expect(execute).toHaveBeenCalledOnce();
});

it.each(['ask', 'ai-review', 'permissive'] as const)(
  'keeps an inspected high-impact script at human or reviewer control in %s mode', async (mode) => {
    const approve = vi.fn(async () => false);
    const evaluate = vi.fn(async (_operation: unknown, _analysis: unknown, _context: unknown) => 'allow' as const);
    const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, stdoutTail: '' }));
    const gate = new SafetyGate({
      analyzer: { analyze: async (raw) => ({ raw, calls: raw.startsWith('sh ')
        ? [{ name: 'sh', args: ['./install.sh'], dynamic: false, redirects: false }]
        : [{ name: 'useradd', args: ['demo'], dynamic: false, redirects: false }],
        redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
        hasRedirection: false, hasError: false }) },
      scripts: { inspect: async () => ({ source: 'useradd demo', sha256: 'sha' }), verify: async () => true },
      evaluator: { evaluate }, approvals: { requestApproval: approve }, executor: { execute },
      audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
      lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode, revision: 1 })
    });
    const outcome = await gate.execute({ ...operation, command: 'sh ./install.sh' });
    if (mode === 'ai-review') {
      expect(evaluate).toHaveBeenCalledOnce();
      expect(evaluate.mock.calls[0]?.[2]).toMatchObject({ classification: { ruleId: 'high-impact-script', impact: 'high' }, inspectedScriptSha256: 'sha' });
      expect(approve).not.toHaveBeenCalled();
      expect(outcome.decision.ruleId).toBe('ai-review-allow');
      expect(execute).toHaveBeenCalledOnce();
    } else {
      // Even the permissive tier keeps asking for identified high impact.
      expect(evaluate).not.toHaveBeenCalled();
      expect(approve).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(outcome.decision.ruleId).toBe('human-denied');
    }
  });

it.each(['ask', 'permissive'] as const)('lets the user approve a high-impact command in %s mode', async (mode) => {
  const approve = vi.fn(async () => true);
  const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, stdoutTail: '' }));
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'useradd', args: ['demo'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'error' }, approvals: { requestApproval: approve }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode, revision: 1 })
  });
  expect((await gate.execute({ ...operation, command: 'useradd demo' })).decision.ruleId).toBe('human-approved');
  expect(approve).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
});

it('routes an identified high-impact command through the reviewer only in ai-review mode', async () => {
  const approve = vi.fn(async () => false);
  const evaluate = vi.fn(async () => 'review' as const);
  const execute = vi.fn(async () => ({ operationId: 'op', status: 'succeeded' as const, stdoutTail: '' }));
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'useradd', args: ['demo'], dynamic: false, redirects: false }],
      redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: false }) },
    evaluator: { evaluate }, approvals: { requestApproval: approve }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ai-review', revision: 1 })
  });
  const outcome = await gate.execute({ ...operation, command: 'useradd demo' });
  expect(evaluate).toHaveBeenCalledOnce();
  // A reviewer that cannot judge high impact falls back to the human, never auto-allows.
  expect(approve).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(outcome.decision.ruleId).toBe('human-denied');
});

it('does not execute if ownership changes while the allow decision is persisted', async () => {
  let generation = 1;
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: 'pwd', args: [], dynamic: false, redirects: false }], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async (_id, decision) => { if (decision.verdict === 'allow') generation++; }, completed: async () => {} },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  const result = await gate.execute({ ...operation, command: 'pwd' });
  expect(result.decision.ruleId).toBe('authorization-expired');
  expect(execute).not.toHaveBeenCalled();
});

it.each([true, false])('mints the read-only executor capability only from strict parsed queries (%s)', async (query) => {
  const execute = vi.fn().mockResolvedValue({ operationId: 'op', status: 'succeeded', stdoutTail: '' });
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [{ name: query ? 'pwd' : 'mkdir', args: query ? [] : ['cache'], dynamic: false, redirects: false }], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  await gate.execute({ ...operation, command: query ? 'pwd' : 'mkdir cache' });
  expect(execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: query, isAuthorized: expect.any(Function) });
});

it('records a sudo file inspection as effect-free while retaining its ordinary review decision', async () => {
  const execute = vi.fn().mockResolvedValue({ operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '' });
  const classified = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async (raw) => ({ raw, calls: [
      { name: 'sudo', args: ['cat', '/root/test/test.py'], dynamic: false, redirects: false },
      { name: 'cat', args: ['/root/test/test.py'], dynamic: false, redirects: false }
    ], steps: [{ call: { name: 'sudo', args: ['cat', '/root/test/test.py'], dynamic: false, redirects: false }, condition: 'always' }],
    redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: true, hasRedirection: false, hasError: false }) },
    evaluator: { evaluate: async () => 'allow' }, approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, classified, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ask', revision: 1 })
  });
  const outcome = await gate.execute({ ...operation, command: 'sudo cat /root/test/test.py' });
  expect(outcome.decision.ruleId).not.toBe('low-risk-command');
  expect(classified).toHaveBeenCalledWith('op', true);
  expect(execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: true });
});

it('fails closed if parser loading throws', async () => {
  const execute = vi.fn();
  const gate = new SafetyGate({
    analyzer: { analyze: async () => { throw new Error('WASM unavailable'); } }, evaluator: { evaluate: async () => 'allow' },
    approvals: { requestApproval: async () => true }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'permissive', revision: 1 })
  });
  expect((await gate.execute(operation)).decision.ruleId).toBe('analyzer-unavailable');
  expect(execute).not.toHaveBeenCalled();
});
