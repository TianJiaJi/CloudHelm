export const DEFAULT_ROUND_REQUEST_LIMIT = 100;
export const REQUEST_BUDGET_INCREMENT = 100;
export const SUMMARY_REQUEST_LIMIT = 32;
export const REVIEW_REQUEST_LIMIT = 3;
export const MAX_HTTP_ATTEMPTS = 3;

export type RequestPurpose = 'conversation' | 'compaction' | 'summary' | 'review';
export interface ModelRequestAttempt {
  /** One logical model request; HTTP retries retain this ID and increase attempt. */
  logicalRequestId: string;
  purpose: RequestPurpose;
  attempt: number;
  /** Opaque routes reserve once conservatively; they do not claim HTTP visibility. */
  transport: 'http' | 'opaque';
}
export interface RequestBudgetState {
  version: 1;
  roundId: string;
  budgetRevision: number;
  roundUsed: number;
  roundLimit: number;
  defaultRoundLimit: number;
  /** Cumulative main conversation/compaction reservations, never reset by a new round. */
  totalUsed: number;
  closed: boolean;
  origin: 'explicit' | 'legacy';
}
export interface RoundCompletion {
  answered: boolean;
  unresolved: boolean;
  reportPending: boolean;
  modelIdle: boolean;
  remoteIdle: boolean;
}
export interface AuxiliaryRequestBudget {
  purpose: 'summary' | 'review';
  scopeId: string;
  used: number;
  limit: number;
}
export type RequestBudgetErrorCode = 'budget-invalid' | 'budget-exhausted' | 'budget-stale' | 'budget-round-closed'
  | 'budget-round-open' | 'budget-not-exhausted' | 'summary-budget-exhausted' | 'review-budget-exhausted';
export class RequestBudgetError extends Error {
  constructor(readonly code: RequestBudgetErrorCode) {
    super(code); this.name = 'RequestBudgetError';
  }
}
function invalid(): never { throw new RequestBudgetError('budget-invalid'); }
function counter(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[\w-][\w.:-]{0,199}(?![\s\S])/u.test(value)) invalid();
}
function plus(value: number, amount: number): number { const next = value + amount; counter(next); return next; }
function exactFields(value: object, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

/** Invalid persisted state never silently turns into a fresh allowance. */
export function assertRequestBudget(value: unknown): asserts value is RequestBudgetState {
  if (!value || typeof value !== 'object') invalid();
  const state = value as Record<string, unknown>;
  exactFields(state, ['version', 'roundId', 'budgetRevision', 'roundUsed', 'roundLimit', 'defaultRoundLimit', 'totalUsed', 'closed', 'origin']);
  if (state.version !== 1 || typeof state.closed !== 'boolean' || (state.origin !== 'explicit' && state.origin !== 'legacy')) invalid();
  id(state.roundId);
  for (const key of ['budgetRevision', 'roundUsed', 'roundLimit', 'defaultRoundLimit', 'totalUsed']) counter(state[key]);
  if ((state.roundUsed as number) > (state.roundLimit as number) || (state.roundUsed as number) > (state.totalUsed as number)) invalid();
}
export function createRequestBudget(roundId: string, limit = DEFAULT_ROUND_REQUEST_LIMIT): RequestBudgetState {
  id(roundId); counter(limit);
  return { version: 1, roundId, budgetRevision: 0, roundUsed: 0, roundLimit: limit,
    defaultRoundLimit: limit, totalUsed: 0, closed: false, origin: 'explicit' };
}
export function legacyRequestBudget(roundId: string, requestCount: number, requestLimit: number): RequestBudgetState {
  counter(requestCount);
  const state = createRequestBudget(roundId, requestLimit);
  return { ...state, roundUsed: Math.min(requestCount, requestLimit), totalUsed: requestCount, origin: 'legacy' };
}
export function remainingRequests(state: RequestBudgetState): number {
  assertRequestBudget(state); return state.roundLimit - state.roundUsed;
}
/** The caller must atomically persist the new state + a unique attempt receipt
 * before dispatch. A lost acknowledgment/cancellation must not refund it. */
export function reserveRoundRequest(state: RequestBudgetState): RequestBudgetState {
  assertRequestBudget(state);
  if (state.closed) throw new RequestBudgetError('budget-round-closed');
  if (!remainingRequests(state)) throw new RequestBudgetError('budget-exhausted');
  return { ...state, roundUsed: plus(state.roundUsed, 1), totalUsed: plus(state.totalUsed, 1), budgetRevision: plus(state.budgetRevision, 1) };
}
/** Closure consumes authoritative completion facts, never assistant prose. */
export function closeRequestRound(state: RequestBudgetState, facts: RoundCompletion): RequestBudgetState {
  assertRequestBudget(state);
  if (state.closed || facts.answered !== true || facts.unresolved !== false || facts.reportPending !== false
    || facts.modelIdle !== true || facts.remoteIdle !== true) return state;
  return { ...state, closed: true, budgetRevision: plus(state.budgetRevision, 1) };
}
/** New work on a previously completed round invalidates completion, not usage.
 * For example, an explicit manual review can create new pending work. */
export function reopenRequestRound(state: RequestBudgetState): RequestBudgetState {
  assertRequestBudget(state);
  return state.closed ? { ...state, closed: false, budgetRevision: plus(state.budgetRevision, 1) } : state;
}
/** Only an authenticated new-user-input boundary may call this after closure. */
export function beginRequestRound(state: RequestBudgetState, roundId: string): RequestBudgetState {
  assertRequestBudget(state); id(roundId);
  if (!state.closed) throw new RequestBudgetError('budget-round-open');
  if (roundId === state.roundId) throw new RequestBudgetError('budget-stale');
  return { ...state, roundId, roundUsed: 0, roundLimit: state.defaultRoundLimit,
    budgetRevision: plus(state.budgetRevision, 1), closed: false, origin: 'explicit' };
}
/** Idempotency belongs to the durable requestId receipt, checked BEFORE this
 * compare-and-add policy. Reusing a stale binding cannot grant another 100. */
export function extendRequestRound(state: RequestBudgetState, binding: { roundId: string; budgetRevision: number }): RequestBudgetState {
  assertRequestBudget(state); id(binding.roundId); counter(binding.budgetRevision);
  if (binding.roundId !== state.roundId || binding.budgetRevision !== state.budgetRevision) throw new RequestBudgetError('budget-stale');
  if (state.closed) throw new RequestBudgetError('budget-round-closed');
  if (remainingRequests(state) > 0) throw new RequestBudgetError('budget-not-exhausted');
  return { ...state, roundLimit: plus(state.roundLimit, REQUEST_BUDGET_INCREMENT), budgetRevision: plus(state.budgetRevision, 1) };
}
export function assertModelRequestAttempt(value: unknown): asserts value is ModelRequestAttempt {
  if (!value || typeof value !== 'object') invalid();
  const request = value as Record<string, unknown>;
  exactFields(request, ['logicalRequestId', 'purpose', 'attempt', 'transport']);
  id(request.logicalRequestId); counter(request.attempt);
  if ((request.attempt as number) < 1 || (request.attempt as number) > MAX_HTTP_ATTEMPTS
    || typeof request.purpose !== 'string' || !['conversation', 'compaction', 'summary', 'review'].includes(request.purpose)
    || (request.transport !== 'http' && request.transport !== 'opaque') || (request.transport === 'opaque' && request.attempt !== 1)) invalid();
}
export function requestAttemptKey(request: ModelRequestAttempt): string {
  assertModelRequestAttempt(request);
  return `${request.logicalRequestId}/${request.attempt}`;
}
export function createAuxiliaryBudget(purpose: 'summary' | 'review', scopeId: string): AuxiliaryRequestBudget {
  id(scopeId);
  if (purpose !== 'summary' && purpose !== 'review') invalid();
  return { purpose, scopeId, used: 0, limit: purpose === 'summary' ? SUMMARY_REQUEST_LIMIT : REVIEW_REQUEST_LIMIT };
}
export function assertAuxiliaryBudget(value: unknown): asserts value is AuxiliaryRequestBudget {
  if (!value || typeof value !== 'object') invalid();
  const state = value as AuxiliaryRequestBudget;
  exactFields(state, ['purpose', 'scopeId', 'used', 'limit']);
  const expected = createAuxiliaryBudget(state.purpose, state.scopeId);
  counter(state.used);
  if (state.limit !== expected.limit || state.used > state.limit) invalid();
}
export function reserveAuxiliaryRequest(state: AuxiliaryRequestBudget): AuxiliaryRequestBudget {
  assertAuxiliaryBudget(state);
  if (state.used === state.limit) throw new RequestBudgetError(state.purpose === 'summary' ? 'summary-budget-exhausted' : 'review-budget-exhausted');
  return { ...state, used: plus(state.used, 1) };
}
