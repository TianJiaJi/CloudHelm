import { expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { OperationImpactSchema, operationNeedsVerification, type OperationView } from '@cloudhelm/contracts';

it('accepts fixed metadata only, not bodies, arbitrary versions or expanded reason text', () => {
  const facts = { version: 1, mutation: 'possible', sensitiveRead: 'unknown', externalTransfer: 'unknown',
    codeExecution: 'unknown', evidence: 'unproven', uncertaintyCodes: ['code-execution'] };
  expect(Value.Check(OperationImpactSchema, facts)).toBe(true);
  for (const invalid of [{ ...facts, content: 'synthetic-secret' }, { ...facts, version: 2 },
    { ...facts, uncertaintyCodes: ['/srv/private'] }, { ...facts, uncertaintyCodes: Array(5).fill('code-execution') }])
    expect(Value.Check(OperationImpactSchema, invalid)).toBe(false);
});

it('never treats metadata as approval, a completion observation or risk reconciliation', () => {
  const operation: OperationView = { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'fixture',
    status: 'unknown', createdAt: 1, impactAnalysis: { version: 1, mutation: 'none', sensitiveRead: 'not-detected',
      externalTransfer: 'not-detected', codeExecution: 'not-detected', evidence: 'query-proof', uncertaintyCodes: [] } };
  expect(operationNeedsVerification(operation)).toBe(true);
  delete operation.impactAnalysis;
  expect(operationNeedsVerification(operation)).toBe(true);
});
