import type { OperationResult } from './model.js';
import { canOfferSuFallback } from './privilege-routing.js';

/** Unified tool-call receipt. `done` never means business success; `running`
 * claims no permanent liveness or service readiness; `rejected` never
 * terminates the task by itself. */
export type OutcomeReceipt = 'done' | 'running' | 'adjudication-required' | 'rejected';

/** Bounded currently available follow-ups; none of them pre-approves a new operation. */
export type OutcomeNextAction = 'continue' | 'inspect-result' | 'verify-outcome' | 'user-decision'
  | 'confirm-alternative' | 'revise-operation' | 'read-log';

export interface OperationOutcome {
  version: 2;
  receipt: OutcomeReceipt;
  /** Dispatch-boundary handoff fact; an unattesting producer surfaces as unknown. */
  handoff: 'not-sent' | 'handed-off' | 'unknown';
  /** Whether the reviewed business action provably began; never inferred from output text. */
  businessStart: 'not-started' | 'started' | 'unknown';
  /** Process liveness at the last trusted observation; a missing exit is never proof of exit. */
  liveness: 'running' | 'exited' | 'unknown';
  /** Observed exit code, else null. */
  exit: number | null;
  effects: 'none' | 'possible' | 'observed-change' | 'unclassified';
  nextActions: readonly OutcomeNextAction[];
  /** No result grants permission to replay a remote action. */
  replay: 'never';
}

/** Pure backend facts. Untrusted output text must never determine dispatch or replay safety. */
export function operationOutcome(result: OperationResult): OperationOutcome {
  const exited = ['succeeded', 'failed'].includes(result.status) && Number.isInteger(result.exitCode) && result.exitCode! >= 0;
  const notStarted = result.status === 'failed' && result.effects === 'none'
    && (result.failureKind === 'unresolved-prior-operation' || result.failureKind === 'not-dispatched'
      || exited && result.privilege?.source === 'transport' && result.privilege.businessCommand === 'not-started');
  const handoff = result.handoff ?? (notStarted ? 'not-sent' : 'unknown');
  const businessStart = result.businessStart ?? (notStarted ? 'not-started' : 'unknown');
  const liveness = result.liveness ?? (exited ? 'exited' : 'unknown');
  const receipt: OutcomeReceipt = notStarted || result.handoff === 'not-sent' && result.status === 'failed'
    ? 'rejected'
    : result.status === 'handed-over' || result.liveness === 'running' ? 'running' : 'done';
  const stopped = result.requiresUserAction || result.authentication === 'failed'
    || ['cancelled', 'timeout', 'attempts-exhausted', 'authentication-rejected', 'authentication-unconfirmed'].includes(result.privilege?.code ?? '');
  const unresolved = !notStarted && !exited;
  const primary: OutcomeNextAction = stopped ? 'user-decision'
    : canOfferSuFallback(result) ? 'confirm-alternative'
      // A dispatch-boundary failure is correctable, not an unresolved remote outcome.
      : result.status === 'failed' && result.effects === 'none' && result.failureKind === 'not-dispatched' ? 'revise-operation'
        : result.failureKind === 'unresolved-prior-operation' || unresolved
          || result.status === 'failed' && result.effects !== 'none' ? 'verify-outcome'
          : result.status === 'succeeded' ? 'continue' : 'inspect-result';
  const nextActions: OutcomeNextAction[] = [primary];
  if (result.logRef && (primary === 'verify-outcome' || primary === 'inspect-result')) nextActions.push('read-log');
  return { version: 2, receipt, handoff, businessStart, liveness,
    exit: exited ? result.exitCode! : null, effects: result.effects ?? 'unclassified', nextActions, replay: 'never' };
}

export function notStartedOutcome(code: string): OperationOutcome {
  const correctable = ['unsupported-probe', 'unsupported-authentication-form', 'unsupported-root-command', 'nested-privilege', 'conflicting-identity',
    'remote-edit-source-changed', 'remote-edit-ambiguous', 'remote-edit-invalid', 'preauthorization-out-of-scope'];
  const primary: OutcomeNextAction = correctable.includes(code) ? 'revise-operation' : code === 'replay-protected' ? 'inspect-result' : 'user-decision';
  return { version: 2, receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started',
    liveness: 'unknown', exit: null, effects: 'none', nextActions: [primary], replay: 'never' };
}
