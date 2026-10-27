import { Type, type Static } from 'typebox';

const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[\\w-][\\w.:-]{0,199}(?![\\s\\S])' });
export const RequestBudgetStateSchema = Type.Object({
  version: Type.Literal(1), roundId: Id, budgetRevision: Counter,
  roundUsed: Counter, roundLimit: Counter, defaultRoundLimit: Counter, totalUsed: Counter,
  closed: Type.Boolean(), origin: Type.Union([Type.Literal('explicit'), Type.Literal('legacy')])
}, { additionalProperties: false });
export type RequestBudgetState = Static<typeof RequestBudgetStateSchema>;
export const ExtendRequestBudgetSchema = Type.Object({
  taskId: Id, roundId: Id, budgetRevision: Counter, requestId: Id
}, { additionalProperties: false });
export type ExtendRequestBudget = Static<typeof ExtendRequestBudgetSchema>;
export interface BudgetExtensionResult {
  budget: RequestBudgetState;
  grant: RequestBudgetGrant;
  continuation: 'blocked' | 'acknowledged' | 'uncertain';
}
export interface RequestBudgetGrant {
  requestId: string; roundId: string;
  phase: 'granted' | 'dispatching' | 'acknowledged';
}
