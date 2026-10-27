import { Value } from 'typebox/value';
import { ExtendRequestBudgetSchema, type RequestBudgetGrant, type BudgetExtensionResult, type TaskView } from '@cloudhelm/contracts';
import { RequestBudgetError } from '@cloudhelm/core';
import type { RequestBudgetAuthority } from './request-budget-authority.js';

interface Dependencies {
  authority: RequestBudgetAuthority;
  live(taskId: string): { task: TaskView; modelIdle: boolean; remoteIdle: boolean };
  restore(taskId: string): Promise<void>;
  resume(taskId: string): Promise<unknown>;
}

/** The durable claim is made before dispatch. A missing reply is NOT permission
 * to retry resume. Increasing allowance never removes a safety stop. */
export async function extendRequestBudget(input: unknown, deps: Dependencies): Promise<BudgetExtensionResult> {
  if (!Value.Check(ExtendRequestBudgetSchema, input)) throw new RequestBudgetError('budget-invalid');
  const binding = structuredClone(input);
  const extension = deps.authority.extend(binding);
  const result = (grant: RequestBudgetGrant, continuation: BudgetExtensionResult['continuation']): BudgetExtensionResult =>
    ({ budget: deps.authority.current(binding.taskId), grant, continuation });
  if (extension.grant.phase !== 'granted') return result(extension.grant,
    extension.grant.phase === 'acknowledged' ? 'acknowledged' : 'uncertain');

  const eligible = (): boolean => {
    const { task, modelIdle, remoteIdle } = deps.live(binding.taskId);
    const budget = deps.authority.current(binding.taskId);
    return task.status === 'paused' && task.resumeReason === 'budget-exhausted' && modelIdle && remoteIdle
      && budget.roundId === binding.roundId && !budget.closed && budget.roundUsed < budget.roundLimit;
  };
  if (!eligible()) return result(extension.grant, 'blocked');
  await deps.restore(binding.taskId);
  if (!eligible()) return result(extension.grant, 'blocked');
  // Another caller may have finished while restoration was pending.
  const latest = deps.authority.extend(binding).grant;
  if (latest.phase !== 'granted') return result(latest, latest.phase === 'acknowledged' ? 'acknowledged' : 'uncertain');
  const claim = deps.authority.advanceGrant(binding.taskId, binding.requestId, 'granted', 'dispatching');
  if (!claim.changed) return result(claim.grant, claim.grant.phase === 'acknowledged' ? 'acknowledged' : 'uncertain');
  await deps.resume(binding.taskId);
  const receipt = deps.authority.advanceGrant(binding.taskId, binding.requestId, 'dispatching', 'acknowledged');
  return result(receipt.grant, 'acknowledged');
}
