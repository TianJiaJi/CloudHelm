import { expect, it } from 'vitest';
import { retainOperationResolution, type OperationView } from '../../packages/contracts/src/index.js';

const observed: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'old write',
  status: 'unknown', effects: 'possible', createdAt: 1 };
const accepted: OperationView = { ...observed, reconciledAt: 42,
  reconciliation: { kind: 'risk-accepted', at: 42, sourceTaskId: 'source', evidenceOperationIds: ['check'], explanation: 'explicit acceptance' } };

it('keeps complete durable resolution metadata across old or reduced worker snapshots', () => {
  expect(retainOperationResolution(accepted, observed)).toEqual(accepted);
  expect(retainOperationResolution(accepted, { ...accepted,
    reconciliation: { kind: 'risk-accepted', at: 42, explanation: 'reduced worker projection' } })).toEqual(accepted);
  expect(observed.reconciliation).toBeUndefined();
});

it('retains actual late execution observations without turning risk acceptance into proof', () => {
  const late = { ...observed, status: 'failed' as const, exitCode: 130, outputTail: 'late exit' };
  expect(retainOperationResolution(accepted, late)).toEqual({ ...late, reconciledAt: 42, reconciliation: accepted.reconciliation });
});

it('does not replace the first persisted resolution with a competing outcome', () => {
  const competing: OperationView = { ...observed, status: 'succeeded', reconciledAt: 43,
    reconciliation: { kind: 'evidence', at: 43, outcome: 'succeeded', evidenceOperationIds: ['new-check'], explanation: 'competing claim' } };
  expect(retainOperationResolution(accepted, competing)).toBe(accepted);
  expect(retainOperationResolution(competing, accepted)).toBe(competing);
  expect(retainOperationResolution(undefined, competing)).toBe(competing);
});

it.each(['id', 'taskId', 'hostId', 'kind'] as const)('does not allow a snapshot to change operation %s', (field) => {
  expect(() => retainOperationResolution(accepted, { ...accepted, [field]: 'foreign' } as OperationView)).toThrow('identity changed');
});
