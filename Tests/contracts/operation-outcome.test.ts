import { describe, expect, it } from 'vitest';
import { operationNeedsVerification, operationOutcomeResolvable, type OperationOutcomeState, type OperationView } from '../../packages/contracts/src/index.js';

const outcome = (status: OperationView['status'], over: Partial<OperationOutcomeState> = {}): OperationOutcomeState =>
  ({ status, ...over });

describe('remote outcome predicates', () => {
  it.each(['proposed', 'approved', 'running', 'unknown'] as const)(
    'blocks host writes while an operation is %s', (status) => {
      expect(operationNeedsVerification(outcome(status))).toBe(true);
    });

  it.each([
    ['proposed', false],
    ['approved', false],
    ['running', false],
    ['unknown', true]
  ] as const)('treats a %s outcome as resolvable: %s', (status, resolvable) => {
    expect(operationOutcomeResolvable(outcome(status))).toBe(resolvable);
  });

  it('blocks and resolves a failure that may have changed the host', () => {
    expect(operationNeedsVerification(outcome('failed', { effects: 'possible' }))).toBe(true);
    expect(operationOutcomeResolvable(outcome('failed', { effects: 'possible' }))).toBe(true);
    expect(operationNeedsVerification(outcome('failed'))).toBe(true);
    expect(operationOutcomeResolvable(outcome('failed'))).toBe(true);
  });

  it('never blocks on read-only operations or confirmed failures without effects', () => {
    expect(operationNeedsVerification(outcome('unknown', { readOnly: true }))).toBe(false);
    expect(operationNeedsVerification(outcome('failed', { readOnly: true, effects: 'possible' }))).toBe(false);
    expect(operationOutcomeResolvable(outcome('unknown', { readOnly: true }))).toBe(false);
    expect(operationNeedsVerification(outcome('failed', { effects: 'none' }))).toBe(false);
    expect(operationOutcomeResolvable(outcome('failed', { effects: 'none' }))).toBe(false);
    expect(operationNeedsVerification(outcome('succeeded'))).toBe(false);
    expect(operationNeedsVerification(outcome('denied'))).toBe(false);
  });

  it('stops blocking once an outcome was resolved, without claiming success', () => {
    for (const status of ['unknown', 'failed'] as const) {
      const resolved = outcome(status, { effects: 'possible', reconciledAt: 10 });
      expect(operationNeedsVerification(resolved)).toBe(false);
      expect(operationOutcomeResolvable(resolved)).toBe(false);
    }
  });
});
