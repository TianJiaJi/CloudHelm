import { describe, expect, it, vi } from 'vitest';
import type { BusinessTool } from '@cloudhelm/core';
import type { AppEvent, OperationView, VerificationReport } from '@cloudhelm/contracts';
import { WorkJournal } from './work-journal.js';

const operation = (id: string, status: OperationView['status'] = 'succeeded', taskId = 'conversation-a'): OperationView => ({
  id, taskId, status, hostId: 'host-a', kind: 'command', preview: 'curl --fail http://localhost:8080/health', createdAt: 1
});
const changed = (id = 'change', hostId = 'host-a'): OperationView => ({ ...operation(id), hostId,
  kind: 'write-file', preview: 'Wrote a file' });
const verification = (id = 'verification', status: OperationView['status'] = 'succeeded', taskId = 'conversation-a', hostId = 'host-a'): OperationView => ({
  ...operation(id, status, taskId), hostId, readOnly: true, createdAt: 2
});
const report = (ids = ['verification']): VerificationReport => ({
  summary: '服务已部署并通过健康检查', access: ['http://localhost:8080'], evidenceOperationIds: ids,
  changes: ['启动服务容器'], recovery: ['使用保存的 compose 配置恢复旧版本']
});

function setup(operations: OperationView[], canReconcile = false, verificationScope = operations) {
  const events: AppEvent[] = [];
  const readLog = vi.fn(async () => ({ text: 'service is healthy', nextCursor: 18, more: false }));
  const reconcile = vi.fn(() => canReconcile);
  const reconciled = vi.fn((_operation: OperationView) => {});
  const journal = new WorkJournal('conversation-a', () => operations, (event) => events.push(event), readLog, reconcile, reconciled, () => verificationScope);
  const call = (name: string, args: unknown) => {
    const tool = journal.tools().find((candidate) => candidate.name === name) as BusinessTool<unknown>;
    return tool.execute(`call-${name}`, args);
  };
  return { journal, events, readLog, call, reconcile, reconciled };
}

describe('verification evidence', () => {
  it.each(['failed', 'denied', 'unknown', 'running', 'proposed', 'approved'] as const)(
    'rejects a %s operation as verification evidence', async (status) => {
      const test = setup([changed(), verification('verification', status)]);
      expect((await test.call('submit_verification', report())).isError).toBe(true);
      expect(test.journal.hasReport()).toBe(false);
      expect(test.events).toEqual([]);
    });

  it('rejects missing or empty evidence even if narrative claims success', async () => {
    const test = setup([]);
    expect((await test.call('submit_verification', report(['nonexistent']))).isError).toBe(true);
    expect((await test.call('submit_verification', report([]))).isError).toBe(true);
    expect(test.journal.hasReport()).toBe(false);
  });

  it('does not accept successful evidence owned by a different conversation', async () => {
    const test = setup([changed(), verification('foreign-check', 'succeeded', 'conversation-b')]);
    expect((await test.call('submit_verification', report(['foreign-check']))).isError).toBe(true);
    expect(test.events).toEqual([]);
  });

  it.each(['unknown', 'running', 'proposed', 'approved'] as const)(
    'rejects acceptance when another operation still has a %s outcome', async (status) => {
      const test = setup([changed(), verification(), operation('pending-operation', status)]);
      expect((await test.call('submit_verification', report())).isError).toBe(true);
      expect(test.journal.hasReport()).toBe(false);
    });

  it('does not treat a user risk acceptance as successful verification evidence', async () => {
    const accepted = { ...operation('risk', 'unknown'), reconciledAt: 20,
      reconciliation: { kind: 'risk-accepted' as const, at: 20, explanation: '用户承担未知结果风险' } };
    const test = setup([changed(), accepted]);
    expect((await test.call('submit_verification', report(['risk']))).isError).toBe(true);
    const withCheck = setup([changed(), accepted, verification()]);
    expect((await withCheck.call('submit_verification', report())).isError).not.toBe(true);
    expect((await withCheck.call('record_reconciled_result', {
      operationId: 'risk', evidenceOperationIds: [], outcome: 'succeeded', explanation: '结果后续已通过新观察得到确认' })))
      .toMatchObject({ isError: false, details: { code: 'already-resolved', reconciliation: { kind: 'risk-accepted' } } });
    expect(withCheck.reconcile).not.toHaveBeenCalled();
  });

  it('does not require reconciliation for a previously classified read-only query', async () => {
    const test = setup([changed(), verification(), { ...operation('old-df', 'unknown'), readOnly: true, preview: 'df -h' }]);
    expect((await test.call('submit_verification', report())).isError).not.toBe(true);
  });

  it('rejects a successful mutation, an earlier check, or a check on another host as evidence', async () => {
    const cases = [
      { operations: [changed()], ids: ['change'] },
      { operations: [verification(), changed()], ids: ['verification'] },
      { operations: [changed(), verification('verification', 'succeeded', 'conversation-a', 'host-b')], ids: ['verification'] },
      { operations: [changed(), verification(), changed('new-change')], ids: ['verification'] },
      { operations: [changed('old', 'host-b'), changed('new', 'host-a'),
        verification('verification', 'succeeded', 'conversation-a', 'host-b')], ids: ['verification'] }
    ];
    for (const sample of cases) {
      const test = setup(sample.operations);
      expect((await test.call('submit_verification', report(sample.ids))).isError).toBe(true);
      expect(test.events).toEqual([]);
    }
  });

  it('requires fresh successful checks on every changed host', async () => {
    const operations = [changed('host-a-write'), changed('host-b-write', 'host-b'),
      verification('host-a-check'), verification('host-b-check', 'succeeded', 'conversation-a', 'host-b')];
    const test = setup(operations);
    expect((await test.call('submit_verification', report(['host-a-check']))).isError).toBe(true);
    expect(test.journal.lastReportIssue()?.code).toBe('verification-evidence-invalid');
    expect((await test.call('submit_verification', report(['host-a-check', 'host-b-check']))).isError).toBe(false);
    expect(test.journal.lastReportIssue()).toBeUndefined();
  });

  it('limits report evidence and changes to the current verification scope across turns', async () => {
    const previous = [changed('old-write'), verification('old-check')];
    const current = [changed('new-write'), verification('new-check')];
    const test = setup([...previous, ...current], false, current);
    expect((await test.call('submit_verification', report(['old-check']))).isError).toBe(true);
    expect((await test.call('submit_verification', report(['new-check']))).isError).toBe(false);
  });

  it('identifies an ineligible compound check and reuses an existing eligible check without more SSH calls', async () => {
    const compound = { ...operation('compound-check'), preview: 'sudo stat /root/test/test.py && sudo head -n 1 /root/test/test.py' };
    const test = setup([changed('install'), changed('cleanup'), compound, verification('final-cat')]);
    const rejected = await test.call('submit_verification', report(['compound-check', 'final-cat']));
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('不合格的证据 ID：compound-check');
    expect(JSON.stringify(rejected)).toContain('host-a: final-cat');
    expect((await test.call('submit_verification', report(['final-cat']))).isError).not.toBe(true);
  });

  it('keeps earlier checks citable as supplementary after a later cleanup change', async () => {
    const operations = [changed('install'), verification('cat-check'), changed('cleanup'), verification('final-ls')];
    const test = setup(operations);
    expect((await test.call('submit_verification', report(['cat-check']))).isError).toBe(true);
    expect((await test.call('submit_verification', report(['cat-check', 'final-ls']))).isError).toBe(false);
    expect(test.journal.hasReport()).toBe(true);
  });

  it('does not accept checks from before any change as evidence', async () => {
    const test = setup([verification('pre-check'), changed('install'), verification('final-check')]);
    expect((await test.call('submit_verification', report(['pre-check', 'final-check']))).isError).toBe(true);
    expect((await test.call('submit_verification', report(['final-check']))).isError).toBe(false);
  });

  it('rejects recognizable credentials in any report field before emitting or storing it', async () => {
    const samples = [
      { summary: 'password=cleartext' },
      { access: ['https://alice:hunter2@example.test/path'] },
      { access: ['https://alice%3Ahunter2@example.test/path'] },
      { changes: ['apiKey: top-secret'] },
      { recovery: ['-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'] }
    ];
    for (const fields of samples) {
      const test = setup([changed(), verification()]);
      const response = await test.call('submit_verification', { ...report(), ...fields });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain('hunter2');
      expect(JSON.stringify(response)).not.toContain('top-secret');
      expect(test.journal.hasReport()).toBe(false);
      expect(test.events).toEqual([]);
    }
  });

  it('requires meaningful access, change and recovery notes before emitting an acceptance report', async () => {
    const test = setup([changed(), verification()]);
    for (const field of ['access', 'changes', 'recovery'] as const) {
      expect((await test.call('submit_verification', { ...report(), [field]: [' '] })).isError).toBe(true);
    }
    expect((await test.call('submit_verification', report())).isError).not.toBe(true);
    expect(test.journal.hasReport()).toBe(true);
    expect(test.events).toEqual([{ type: 'work-report', taskId: 'conversation-a', report: report() }]);
    test.journal.resetReport();
    expect(test.journal.hasReport()).toBe(false);
  });
});

describe('operation log access', () => {
  it('only reads an operation from the current conversation and forwards its page cursor', async () => {
    const test = setup([operation('own'), operation('foreign', 'succeeded', 'conversation-b')]);
    expect((await test.call('read_operation_log', { operationId: 'missing' })).isError).toBe(true);
    expect((await test.call('read_operation_log', { operationId: 'foreign' })).isError).toBe(true);
    expect(test.readLog).not.toHaveBeenCalled();
    const result = await test.call('read_operation_log', { operationId: 'own', cursor: 12 });
    expect(result.isError).not.toBe(true);
    expect(test.readLog).toHaveBeenCalledExactlyOnceWith('own', 12);
    expect(result.details).toMatchObject({ operationId: 'own', cursor: 12, nextCursor: 18, more: false,
      availability: 'available', completeness: 'unknown', sourceReadOnly: 'unclassified' });
    expect(result.content[0]?.text).toContain('service is healthy');
  });
});

describe('visible plans', () => {
  it('rejects duplicate identifiers and empty step titles without changing visible progress', async () => {
    const test = setup([]);
    expect((await test.call('update_plan', { steps: [
      { id: 'inspect', title: '检查服务', status: 'running' }, { id: 'inspect', title: '部署服务', status: 'pending' }
    ] })).isError).toBe(true);
    expect((await test.call('update_plan', { steps: [{ id: 'inspect', title: ' ', status: 'running' }] })).isError).toBe(true);
    expect(test.events).toEqual([]);
  });
});

describe('reconciling unknown remote outcomes', () => {
  const reconcileRequest = (evidenceOperationIds = ['fresh-check']) => ({
    operationId: 'unknown-deployment', evidenceOperationIds, outcome: 'succeeded',
    explanation: '已重新检查容器状态和健康端点，确认上一次部署命令成功完成。'
  });
  const unknownOperation = () => ({ ...operation('unknown-deployment', 'unknown'), createdAt: 20 });
  const freshEvidence = () => ({ ...verification('fresh-check'), createdAt: 30 });

  it.each([
    ['missing', undefined],
    ['older', { ...freshEvidence(), createdAt: 10 }],
    ['same timestamp', { ...freshEvidence(), createdAt: 20 }],
    ['different host', { ...freshEvidence(), hostId: 'host-b' }],
    ['different conversation', { ...freshEvidence(), taskId: 'conversation-b' }],
    ['failed check', { ...freshEvidence(), status: 'failed' as const }]
  ])('rejects %s evidence without clearing an unknown result', async (_label, evidence) => {
    const original = unknownOperation();
    const test = setup([original, ...(evidence ? [evidence] : [])], true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(original.status).toBe('unknown');
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.reconciled).not.toHaveBeenCalled();
  });

  it('requires nonempty evidence and an actual unknown target in this conversation', async () => {
    const foreignTarget = { ...unknownOperation(), taskId: 'conversation-b' };
    const test = setup([foreignTarget, freshEvidence()], true);
    expect((await test.call('record_reconciled_result', reconcileRequest([]))).isError).toBe(true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(foreignTarget.status).toBe('unknown');
  });

  it('cannot clear a still-running original command despite a newer successful inspection', async () => {
    const original = { ...unknownOperation(), status: 'running' as const };
    const test = setup([original, freshEvidence()], true);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(original.status).toBe('running');
    expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.reconciled).not.toHaveBeenCalled();
  });

  it('preserves unknown status if the execution coordinator cannot reconcile it', async () => {
    const original = unknownOperation();
    const test = setup([original, freshEvidence()], false);
    expect((await test.call('record_reconciled_result', reconcileRequest())).isError).toBe(true);
    expect(test.reconcile).toHaveBeenCalledExactlyOnceWith(original);
    expect(test.reconciled).not.toHaveBeenCalled();
    expect(original.status).toBe('unknown');
    expect(original.reason).toBeUndefined();
  });

  it.each(['succeeded', 'failed'] as const)('records an observed %s result only after coordinator approval, then synchronously reports it', async (outcome) => {
    const original = unknownOperation();
    const test = setup([original, freshEvidence()], true);
    test.reconciled.mockImplementation((updated) => {
      expect(updated.status).toBe(outcome);
      expect(updated.reason).toContain('fresh-check');
    });
    const result = await test.call('record_reconciled_result', { ...reconcileRequest(), outcome });
    expect(result.isError).not.toBe(true);
    expect(test.reconcile).toHaveBeenCalledExactlyOnceWith(original);
    expect(test.reconciled).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.status).toBe(outcome);
    expect(original.reconciliation).toMatchObject({ kind: 'evidence', outcome, evidenceOperationIds: ['fresh-check'] });
    expect(test.journal.hasReport()).toBe(false);
  });
});
