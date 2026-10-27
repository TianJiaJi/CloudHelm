import { expect, it } from 'vitest';
import { assertModelRequestAttempt, assertRequestBudget, beginRequestRound, closeRequestRound, createAuxiliaryBudget,
  createRequestBudget, extendRequestRound, legacyRequestBudget, remainingRequests, reopenRequestRound,
  requestAttemptKey, reserveAuxiliaryRequest, reserveRoundRequest, type RoundCompletion } from './request-budget.js';

const done: RoundCompletion = { answered: true, unresolved: false, reportPending: false, modelIdle: true, remoteIdle: true };
it('allows precisely 100 reservations and refuses the 101st without changing the last snapshot', () => {
  let state = createRequestBudget('round-1');
  for (let index = 0; index < 100; index++) state = reserveRoundRequest(Object.freeze(state));
  expect(state).toMatchObject({ roundUsed: 100, roundLimit: 100, totalUsed: 100, budgetRevision: 100 });
  expect(remainingRequests(state)).toBe(0);
  expect(() => reserveRoundRequest(state)).toThrow('budget-exhausted');
  expect(state.roundUsed).toBe(100);
});
it('requires a clean authoritative completion before starting a new allowance and retains lifetime use', () => {
  const used = reserveRoundRequest(createRequestBudget('old', 1));
  expect(() => beginRequestRound(used, 'new')).toThrow('budget-round-open');
  const closed = closeRequestRound(used, done);
  expect(() => reserveRoundRequest(closed)).toThrow('budget-round-closed');
  expect(() => beginRequestRound(closed, 'old')).toThrow('budget-stale');
  const fresh = beginRequestRound(closed, 'new');
  expect(fresh).toMatchObject({ roundId: 'new', roundUsed: 0, roundLimit: 1, totalUsed: 1, closed: false });
  expect(reserveRoundRequest(fresh).totalUsed).toBe(2);
});
it.each<Partial<RoundCompletion>>([
  { answered: false }, { unresolved: true }, { reportPending: true }, { modelIdle: false }, { remoteIdle: false }
])('does not close a round while any completion condition is missing', (blocked) => {
  const state = createRequestBudget('round');
  expect(closeRequestRound(state, { ...done, ...blocked })).toBe(state);
});
it('reopening completed work never refills it', () => {
  const used = reserveRoundRequest(createRequestBudget('round', 1));
  const reopened = reopenRequestRound(closeRequestRound(used, done));
  expect(reopened).toMatchObject({ closed: false, roundUsed: 1, totalUsed: 1 });
  expect(() => reserveRoundRequest(reopened)).toThrow('budget-exhausted');
});
it.each([[97, 100, 3], [100, 100, 0], [250, 100, 0], [2, 3, 1], [0, 0, 0]])(
  'preserves legacy remaining allowance conservatively (%i/%i)', (count, limit, remaining) => {
    const migrated = legacyRequestBudget('legacy:task', count!, limit!);
    expect(remainingRequests(migrated)).toBe(remaining);
    expect(migrated.totalUsed).toBe(count);
    expect(migrated.defaultRoundLimit).toBe(limit);
    expect(migrated.origin).toBe('legacy');
    const restored: unknown = JSON.parse(JSON.stringify(migrated));
    assertRequestBudget(restored);
    expect(restored).toEqual(migrated);
  }
);
it('binds a fixed 100 increment to the exact exhausted round/revision; never increases future-round defaults', () => {
  const state = reserveRoundRequest(createRequestBudget('round', 1));
  const binding = { roundId: state.roundId, budgetRevision: state.budgetRevision };
  const extended = extendRequestRound(Object.freeze(state), binding);
  expect(extended).toMatchObject({ roundUsed: 1, roundLimit: 101, totalUsed: 1, defaultRoundLimit: 1 });
  expect(remainingRequests(extended)).toBe(100);
  expect(() => extendRequestRound(extended, binding)).toThrow('budget-stale');
  expect(() => extendRequestRound(extended, { roundId: extended.roundId, budgetRevision: extended.budgetRevision })).toThrow('budget-not-exhausted');
  expect(() => extendRequestRound(state, { ...binding, roundId: 'foreign' })).toThrow('budget-stale');
  const next = beginRequestRound(closeRequestRound(extended, done), 'next');
  expect(next.roundLimit).toBe(1);
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects corrupt counters instead of minting fresh credits (%s)', (invalid) => {
  expect(() => legacyRequestBudget('legacy', invalid, 100)).toThrow('budget-invalid');
  expect(() => legacyRequestBudget('legacy', 1, invalid)).toThrow('budget-invalid');
  expect(() => assertRequestBudget({ ...createRequestBudget('round'), roundUsed: invalid })).toThrow('budget-invalid');
});
it('refuses unknown versions, inconsistent state and arithmetic overflow', () => {
  const state = createRequestBudget('round');
  for (const corrupt of [{ ...state, version: 2 }, { ...state, roundUsed: 1 }, { ...state, origin: {} },
    { ...state, roundUsed: 101, totalUsed: 101 }, { ...state, closed: 'false' }]) expect(() => assertRequestBudget(corrupt)).toThrow('budget-invalid');
  expect(() => reserveRoundRequest({ ...state, totalUsed: Number.MAX_SAFE_INTEGER })).toThrow('budget-invalid');
  expect(() => closeRequestRound({ ...state, budgetRevision: Number.MAX_SAFE_INTEGER }, done)).toThrow('budget-invalid');
  const huge = { ...state, roundUsed: Number.MAX_SAFE_INTEGER, roundLimit: Number.MAX_SAFE_INTEGER, totalUsed: Number.MAX_SAFE_INTEGER };
  expect(() => extendRequestRound(huge, { roundId: huge.roundId, budgetRevision: 0 })).toThrow('budget-invalid');
});
it.each(['summary', 'review'] as const)('bounds %s attempts independently without spending main-round credits', (purpose) => {
  const main = createRequestBudget('round');
  let budget = createAuxiliaryBudget(purpose, 'scope');
  const expected = purpose === 'summary' ? 32 : 3;
  for (let index = 0; index < expected; index++) budget = reserveAuxiliaryRequest(Object.freeze(budget));
  expect(budget.used).toBe(expected);
  expect(() => reserveAuxiliaryRequest(budget)).toThrow(`${purpose}-budget-exhausted`);
  expect(main.roundUsed).toBe(0);
  expect(() => reserveAuxiliaryRequest({ ...budget, limit: expected + 1 })).toThrow('budget-invalid');
});
it('distinguishes logical requests from HTTP attempts and does not claim opaque routes can retry', () => {
  const attempt = { logicalRequestId: 'logical', purpose: 'conversation' as const, attempt: 1, transport: 'http' as const };
  expect(requestAttemptKey(attempt)).toBe('logical/1');
  expect(requestAttemptKey({ ...attempt, attempt: 2 })).toBe('logical/2');
  assertModelRequestAttempt({ ...attempt, transport: 'opaque' });
  for (const invalid of [{ ...attempt, attempt: 0 }, { ...attempt, attempt: 4 }, { ...attempt, transport: 'opaque', attempt: 2 },
    { ...attempt, logicalRequestId: 'contains/newline\n' }, { ...attempt, purpose: {} }, { ...attempt, transport: 'guessed' }]) {
    expect(() => assertModelRequestAttempt(invalid)).toThrow('budget-invalid');
  }
});
