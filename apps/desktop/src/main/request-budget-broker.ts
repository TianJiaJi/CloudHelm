import { Value } from 'typebox/value';
import { RequestBudgetError } from '@cloudhelm/core';
import { BudgetCommandSchema, BudgetErrorSchema, type BudgetCommand, type BudgetOutcome } from '@cloudhelm/contracts';
import type { RequestBudgetAuthority } from './request-budget-authority.js';

/** The caller must validate the live task/preparation/review binding. In
 * particular, an arbitrary worker-supplied auxiliary scope must never mint a
 * fresh summary/review allowance. No authorization callback means no access. */
export function createBudgetRequestHandler(authority: RequestBudgetAuthority,
  authorize: (command: Readonly<BudgetCommand>) => void): (input: unknown) => BudgetOutcome {
  return (input) => {
    try {
      if (!Value.Check(BudgetCommandSchema, input)) throw new RequestBudgetError('budget-invalid');
      const command = structuredClone(input);
      authorize(command);
      switch (command.kind) {
        case 'current': return { value: { kind: 'current', taskId: command.taskId, budget: authority.current(command.taskId) } };
        case 'reserve': {
          const result = authority.reserve(command.taskId, command.roundId, command.attempt, command.preparationId);
          return { value: { kind: 'reserve', taskId: command.taskId, ...result,
            ...(command.preparationId === undefined ? {} : { preparationId: command.preparationId }) } };
        }
        case 'summary': {
          const scope = authority.reserveAuxiliary('summary', command.requestId, command.attempt);
          return { value: { kind: 'summary', scopeId: command.requestId, used: scope.used, limit: 32 } };
        }
        case 'review': {
          const scope = authority.reserveAuxiliary('review', command.operationId, command.attempt);
          return { value: { kind: 'review', scopeId: command.operationId, used: scope.used, limit: 3 } };
        }
      }
    } catch (error) {
      // Never transmit storage errors, paths, raw provider responses or secrets.
      return { error: error instanceof RequestBudgetError && Value.Check(BudgetErrorSchema, error.code)
        ? error.code : 'budget-unavailable' };
    }
  };
}
