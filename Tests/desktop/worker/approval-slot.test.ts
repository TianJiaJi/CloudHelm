import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalCoordinator, SafetyGate } from '@cloudhelm/application';
import type { ApprovalWaitBinding, ProposedOperation } from '@cloudhelm/core';
import { BashAnalyzer } from '../../../packages/adapters/src/bash-analyzer.js';
import { FULLY_SERIAL_LIMITS, OperationScheduler } from '../../../apps/desktop/src/worker/operation-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const analyzer = new BashAnalyzer();
  const scheduler = new OperationScheduler(FULLY_SERIAL_LIMITS);
  const opened: ApprovalWaitBinding[] = [], outcomes: string[] = [];
  const approval = new ApprovalCoordinator<ApprovalWaitBinding>({ opened: (view) => opened.push(view), reminder() {}, closed() {} });
  cleanup.push(() => approval.dispose());
  let revision = 1;
  const execute = vi.fn(async (op: ProposedOperation) => ({ operationId: op.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: '' }));
  const gate = new SafetyGate({ analyzer, executor: { execute }, evaluator: { evaluate: async () => 'error' },
    approvals: { requestApproval: (request) => approval.request({ id: request.id, taskId: request.operation.scope.taskId,
      operationId: request.operation.id, hostId: request.operation.scope.hostId, fingerprint: request.fingerprint,
      expiresAt: request.expiresAt, hardExpiresAt: request.hardExpiresAt }), cancelApproval: (id) => approval.cancel(id) },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => 1, isAgentOwner: () => true }, settings: () => ({ mode: 'ask', revision }) });
  const operation = (id: string, command: string): ProposedOperation => ({ id, kind: 'command', command, scope: {
    taskId: 'task', hostId: 'host', cwd: '/tmp', runAs: 'user', terminalId: id, terminalGeneration: 1,
    policyRevision: 1, allowedWorkingRoots: ['/tmp'], protectedPaths: [], goal: 'G1 scheduling contract' } });
  const run = (id: string, command = 'df -h', signal?: AbortSignal) => {
    const op = operation(id, command);
    return scheduler.run({ taskId: 'task', terminalId: 'conversation' }, op, analyzer,
      (slot) => gate.execute(op, signal, false, { withApprovalWait: (wait, approvalSignal) => slot.whileWaiting(async () => {
        const result = await wait(); outcomes.push(id); return result;
      }, (value) => value === 'approved', approvalSignal) }));
  };
  return { run, execute, approval, opened, outcomes, changePolicy: () => { revision++; } };
}

it('releases the entire serial slot while approval waits, without dispatching the unapproved write', async () => {
  const f = fixture();
  const first = f.run('write', 'systemctl restart demo.service');
  try {
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    expect((await f.run('inspect')).result?.status).toBe('succeeded');
    expect(f.execute.mock.calls.map(([op]) => op.id)).toEqual(['inspect']);
    f.approval.decide(f.opened[0]!.id, true);
    expect((await first).result?.status).toBe('succeeded');
    expect(f.execute.mock.calls.map(([op]) => op.id)).toEqual(['inspect', 'write']);
  } finally { f.approval.dispose(); await first; }
});

it('keeps a parked lane alive and rechecks policy after reacquiring behind active work', async () => {
  const f = fixture(); const held = deferred<void>();
  const first = f.run('write', 'systemctl restart demo.service');
  let active: ReturnType<typeof f.run> | undefined;
  try {
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    await f.run('completed-inspection'); // Empty active queue must not delete the parked lane.
    f.execute.mockImplementationOnce(async (op) => { await held.promise; return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }; });
    active = f.run('active-inspection');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    f.approval.decide(f.opened[0]!.id, true);
    await vi.waitFor(() => expect(f.outcomes).toContain('write'));
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.changePolicy(); held.resolve(); await active;
    expect((await first).decision.ruleId).toBe('authorization-expired');
    expect(f.execute.mock.calls.map(([op]) => op.id)).toEqual(['completed-inspection', 'active-inspection']);
  } finally { held.resolve(); f.approval.dispose(); await active; await first; }
});

it.each(['cancel', 'deny'] as const)('unwinds %s without waiting for an unrelated active slot or dispatching the write', async (action) => {
  const f = fixture(); const controller = new AbortController(); const held = deferred<void>();
  const first = f.run('write', 'systemctl restart demo.service', controller.signal);
  let active: ReturnType<typeof f.run> | undefined;
  try {
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    f.execute.mockImplementationOnce(async (op) => { await held.promise; return { operationId: op.id, status: 'succeeded', exitCode: 0, stdoutTail: '' }; });
    active = f.run('active-inspection');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    if (action === 'deny') f.approval.decide(f.opened[0]!.id, false);
    else {
      f.approval.decide(f.opened[0]!.id, true);
      await vi.waitFor(() => expect(f.outcomes).toContain('write'));
      controller.abort();
    }
    const result = await first;
    expect(result.decision.ruleId).toBe(action === 'deny' ? 'human-denied' : 'review-canceled');
    expect(f.execute.mock.calls.map(([op]) => op.id)).toEqual(['active-inspection']);
    held.resolve(); await active;
    expect((await f.run('later-inspection')).result?.status).toBe('succeeded');
  } finally { held.resolve(); f.approval.dispose(); controller.abort(); await active; await first; }
});
