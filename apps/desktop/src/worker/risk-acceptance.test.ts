import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { applyCommittedRiskAcceptance, assertCommittedRiskAcceptance } from './risk-acceptance.js';

const unknown: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'old write',
  status: 'unknown', effects: 'possible', createdAt: 1 };
const accepted: OperationView = { ...unknown, reconciledAt: 42, reconciliation: { kind: 'risk-accepted', at: 42,
  sourceTaskId: 'recovery-task', evidenceOperationIds: ['inspection'], explanation: 'user accepted uncertainty' } };

it('replaces a competing local assessment with the committed acceptance, without claiming success', () => {
  const assessed: OperationView = { ...unknown, status: 'succeeded', reason: 'competing assessment', reconciledAt: 43,
    reconciliation: { kind: 'evidence', at: 43, outcome: 'succeeded', explanation: 'observed file exists', evidenceOperationIds: ['check'] } };
  const result = applyCommittedRiskAcceptance(assessed, accepted);
  expect(result).toEqual(accepted);
  expect(result).not.toBe(accepted);
  expect(assessed.reconciliation?.kind).toBe('evidence');
});

it.each(['succeeded', 'failed'] as const)('does not erase an actual %s exit that arrived before the commit message', (status) => {
  const observed: OperationView = { ...unknown, status, exitCode: status === 'succeeded' ? 0 : 130, outputTail: 'observed exit' };
  const result = applyCommittedRiskAcceptance(observed, accepted);
  expect(result).toEqual({ ...observed, reconciledAt: 42, reconciliation: accepted.reconciliation });
  expect(applyCommittedRiskAcceptance(result, accepted)).toEqual(result);
});

it.each(['id', 'taskId', 'hostId', 'kind'] as const)('rejects mismatched %s without mutating either snapshot', (field) => {
  expect(() => applyCommittedRiskAcceptance(unknown, { ...accepted, [field]: 'foreign' } as OperationView)).toThrow('身份不匹配');
  expect(unknown.reconciledAt).toBeUndefined();
});

it.each([
  { reconciledAt: undefined }, { reconciledAt: NaN }, { reconciledAt: -1 }, { readOnly: true },
  { status: 'running' as const }, { status: 'succeeded' as const }, { reconciliation: undefined },
  { reconciliation: { ...accepted.reconciliation!, at: 44 } }
])('rejects invalid acceptance before any write-lock release: %j', (changes) => {
  expect(() => assertCommittedRiskAcceptance({ ...accepted, ...changes })).toThrow('未解除写锁');
});
