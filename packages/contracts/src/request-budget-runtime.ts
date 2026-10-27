import { Type, type Static } from 'typebox';
import { RequestBudgetStateSchema } from './request-budget.js';

const Id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[\\w-][\\w.:-]{0,199}(?![\\s\\S])' });
export const ModelRequestAttemptSchema = Type.Object({
  logicalRequestId: Id, attempt: Type.Integer({ minimum: 1, maximum: 3 }),
  purpose: Type.Union([Type.Literal('conversation'), Type.Literal('compaction'), Type.Literal('summary'), Type.Literal('review')]),
  transport: Type.Union([Type.Literal('http'), Type.Literal('opaque')])
}, { additionalProperties: false });
export const BudgetCommandSchema = Type.Union([
  Type.Object({ kind: Type.Literal('current'), taskId: Id }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('reserve'), taskId: Id, roundId: Id, preparationId: Type.Optional(Id), attempt: ModelRequestAttemptSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('summary'), requestId: Id, attempt: ModelRequestAttemptSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('review'), taskId: Id, operationId: Id, attempt: ModelRequestAttemptSchema }, { additionalProperties: false })
]);
export type BudgetCommand = Static<typeof BudgetCommandSchema>;
export const BudgetValueSchema = Type.Union([
  Type.Object({ kind: Type.Literal('current'), taskId: Id, budget: RequestBudgetStateSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('reserve'), taskId: Id, preparationId: Type.Optional(Id), budget: RequestBudgetStateSchema, duplicate: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('summary'), scopeId: Id, used: Type.Integer({ minimum: 1, maximum: 32 }), limit: Type.Literal(32) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('review'), scopeId: Id, used: Type.Integer({ minimum: 1, maximum: 3 }), limit: Type.Literal(3) }, { additionalProperties: false })
]);
export type BudgetValue = Static<typeof BudgetValueSchema>;
export const BudgetErrorSchema = Type.Union([
  Type.Literal('budget-invalid'), Type.Literal('budget-exhausted'), Type.Literal('budget-stale'),
  Type.Literal('budget-round-closed'), Type.Literal('budget-round-open'), Type.Literal('budget-not-exhausted'),
  Type.Literal('summary-budget-exhausted'), Type.Literal('review-budget-exhausted'), Type.Literal('budget-unavailable')
]);
export type BudgetError = Static<typeof BudgetErrorSchema>;
export type BudgetOutcome = { value: BudgetValue; error?: never } | { error: BudgetError; value?: never };
export type BudgetRequestMessage = { budgetRequest: { id: string; command: BudgetCommand } };
export const BudgetResultSchema = Type.Union([
  Type.Object({ id: Id, value: BudgetValueSchema }, { additionalProperties: false }),
  Type.Object({ id: Id, error: BudgetErrorSchema }, { additionalProperties: false })
]);
export type BudgetResult = Static<typeof BudgetResultSchema>;
