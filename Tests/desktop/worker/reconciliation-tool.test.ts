import { describe, expect, it, vi } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { HostSerialExecutor } from '@cloudhelm/application';
import type { OperationExecutor, OperationResult, ProposedOperation } from '@cloudhelm/core';
import { createReconciliationTool } from '../../../apps/desktop/src/worker/reconciliation-tool.js';

const original = (): OperationView => ({ id: 'original', taskId: 'task', hostId: 'host', kind: 'command',
  preview: 'touch /tmp/config', createdAt: 1, status: 'unknown', effects: 'possible', readOnly: false });
const check = (): OperationView => ({ ...original(), id: 'check', preview: 'stat /tmp/config',
  createdAt: 2, status: 'succeeded', readOnly: true, effects: 'none' });
const request = { operationId: 'original', evidenceOperationIds: ['check'], outcome: 'succeeded' as 'succeeded' | 'failed',
  explanation: 'Observed the requested configuration file using an existing successful read-only check.' };
function setup(operations: OperationView[]) {
  const reconcile = vi.fn(() => true);
  const reconciled = vi.fn();
  const tool = createReconciliationTool({ taskId: 'task', operations: () => operations, reconcile, reconciled });
  return { reconcile, reconciled, call: (value = request) => tool.execute('reconciliation', value) };
}

describe('specific and idempotent reconciliation feedback', () => {
  it.each([
    ['evidence-unavailable', undefined],
    ['evidence-unavailable', { ...check(), taskId: 'foreign' }],
    ['evidence-wrong-host', { ...check(), hostId: 'other' }],
    ['evidence-not-newer', { ...check(), createdAt: 1 }],
    ['evidence-not-query', { ...check(), readOnly: false }],
    ['evidence-not-query', { ...check(), readOnly: undefined }],
    ['evidence-not-successful', { ...check(), status: 'failed' as const }],
    ['evidence-not-successful', { ...check(), reconciledAt: 3,
      reconciliation: { kind: 'risk-accepted' as const, at: 3, explanation: 'acceptance is not success' } }]
  ])('returns %s without unlocking or changing the target', async (code, evidence) => {
    const target = original();
    const f = setup([target, ...(evidence ? [evidence] : [])]);
    expect(await f.call()).toMatchObject({ isError: true, details: { code, operationId: 'original' } });
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.reconciled).not.toHaveBeenCalled();
    expect(target).toEqual(original());
  });

  it('returns reusable eligible IDs rather than recommending an unconditional new inspection', async () => {
    const f = setup([original(), check(), { ...check(), id: 'write', readOnly: false }]);
    expect(await f.call({ ...request, evidenceOperationIds: ['write'] }))
      .toMatchObject({ details: { code: 'evidence-not-query', eligibleEvidenceOperationIds: ['check'] } });
  });

  it('rejects unknown, foreign and query-only targets distinctly from missing evidence', async () => {
    for (const target of [undefined, { ...original(), taskId: 'foreign' }]) {
      expect(await setup(target ? [target, check()] : [check()]).call()).toMatchObject({ details: { code: 'target-unavailable' } });
    }
    expect(await setup([{ ...original(), readOnly: true }, check()]).call()).toMatchObject({ details: { code: 'target-not-resolvable' } });
    expect(await setup([original(), check()]).call({ ...request, evidenceOperationIds: [] })).toMatchObject({ details: { code: 'evidence-missing' } });
  });

  it('sees risk acceptance that arrives before a queued tool executes, without relabeling it as evidence', async () => {
    const old = original();
    const current: OperationView = { ...old, reconciledAt: 42, reconciliation: { kind: 'risk-accepted', at: 42, explanation: 'user accepted uncertainty' } };
    const operations = [old];
    const f = setup(operations);
    const queued = Promise.resolve().then(() => f.call({ ...request, evidenceOperationIds: [] }));
    operations.push(current);
    expect(await queued).toMatchObject({ isError: false, details: { code: 'already-resolved', status: 'unknown',
      reconciledAt: 42, reconciliation: { kind: 'risk-accepted' }, eligibleEvidenceOperationIds: [] } });
    expect(current.reconciliation?.kind).toBe('risk-accepted');
    expect(old.reconciledAt).toBeUndefined();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.reconciled).not.toHaveBeenCalled();
  });

  it('records one outcome and makes both overlapping and later repetitions no-ops', async () => {
    const target = original();
    const f = setup([target, check()]);
    const replies = await Promise.all([f.call(), f.call()]);
    expect(replies).toMatchObject([{ details: { code: 'outcome-recorded' } }, { details: { code: 'already-resolved' } }]);
    const saved = structuredClone(target);
    expect(await f.call({ ...request, outcome: 'failed', evidenceOperationIds: [], explanation: 'A different requested narrative must not overwrite the recorded one.' }))
      .toMatchObject({ details: { code: 'already-resolved', reconciliation: { kind: 'evidence', outcome: 'succeeded' } } });
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.reconciled).toHaveBeenCalledOnce();
    expect(target).toEqual(saved);
  });

  it.each(['password=secret-secret', 'https://alice:hunter2@example.test/a', 'https://alice%3Ahunter2@example.test/a'])(
    'does not persist or echo credential-bearing explanations', async (secret) => {
      const target = original();
      const f = setup([target, check()]);
      const result = await f.call({ ...request, explanation: `Observed result containing ${secret}` });
      expect(result).toMatchObject({ isError: true, details: { code: 'explanation-invalid' } });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(target).toEqual(original());
    });

  it('cannot reconcile a query-looking result while the original executor still tracks a live process', async () => {
    let finish!: (result: 'exited' | 'unknown') => void;
    const remoteCompletion = new Promise<'exited' | 'unknown'>((resolve) => { finish = resolve; });
    const executor: OperationExecutor = { execute: vi.fn(async (operation: ProposedOperation): Promise<OperationResult> => ({ operationId: operation.id,
      status: 'unknown', effects: 'possible', stdoutTail: '', remoteCompletion })) };
    const serial = new HostSerialExecutor(executor);
    const proposed: ProposedOperation = { id: 'original', kind: 'command', command: 'touch /tmp/config',
      scope: { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
        terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: 'test' } };
    await serial.execute(proposed, 'fingerprint', undefined, { readOnly: false });
    expect(serial.canReconcile('host', 'original')).toBe(false);
    const target = original();
    const recorded = vi.fn();
    const tool = createReconciliationTool({ taskId: 'task', operations: () => [target, check()],
      reconcile: (operation) => serial.reconcile(operation.hostId, operation.id), reconciled: recorded });
    try {
      expect(await tool.execute('call', request)).toMatchObject({ details: { code: 'original-still-running' }, isError: true });
      expect(recorded).not.toHaveBeenCalled();
      expect(target.status).toBe('unknown');
      expect(await serial.execute({ ...proposed, id: 'another-write' }, 'different', undefined, { readOnly: false }))
        .toMatchObject({ failureKind: 'unresolved-prior-operation', effects: 'none' });
    } finally {
      finish('unknown');
      await remoteCompletion;
    }
  });
});
