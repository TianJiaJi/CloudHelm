import type { OperationResult } from './model.js';
import { canOfferSuFallback } from './privilege-routing.js';

export interface OperationOutcome {
  version: 1;
  /** Finished describes the observed process, never completion of the user's business goal. */
  execution: 'not-started' | 'finished' | 'unknown';
  effects: 'none' | 'possible' | 'unclassified';
  nextAction: 'continue' | 'inspect-result' | 'verify-outcome' | 'user-decision' | 'confirm-alternative' | 'revise-operation';
  /** No result grants permission to replay a remote action. */
  replay: 'never';
}

/** Pure backend facts. Untrusted output text must never determine dispatch or replay safety. */
export function operationOutcome(result: OperationResult): OperationOutcome {
  const exited = ['succeeded', 'failed'].includes(result.status) && Number.isInteger(result.exitCode) && result.exitCode! >= 0;
  const notStarted = result.status === 'failed' && result.effects === 'none'
    && (result.failureKind === 'unresolved-prior-operation' || result.failureKind === 'not-dispatched'
      || exited && result.privilege?.source === 'transport' && result.privilege.businessCommand === 'not-started');
  const execution = notStarted ? 'not-started' : exited ? 'finished' : 'unknown';
  const stopped = result.requiresUserAction || result.authentication === 'failed'
    || ['cancelled', 'timeout', 'attempts-exhausted', 'authentication-rejected', 'authentication-unconfirmed'].includes(result.privilege?.code ?? '');
  const nextAction = stopped ? 'user-decision'
    : canOfferSuFallback(result) ? 'confirm-alternative'
      // A dispatch-boundary failure is correctable, not an unresolved remote outcome.
      : result.status === 'failed' && result.effects === 'none' && result.failureKind === 'not-dispatched' ? 'revise-operation'
        : result.failureKind === 'unresolved-prior-operation' || execution === 'unknown'
          || result.status === 'failed' && result.effects !== 'none' ? 'verify-outcome'
          : result.status === 'succeeded' ? 'continue' : 'inspect-result';
  return { version: 1, execution, effects: result.effects ?? 'unclassified', nextAction, replay: 'never' };
}

export function notStartedOutcome(code: string): OperationOutcome {
  const correctable = ['unsupported-probe', 'unsupported-authentication-form', 'unsupported-root-command', 'nested-privilege', 'conflicting-identity'];
  return { version: 1, execution: 'not-started', effects: 'none',
    nextAction: correctable.includes(code) ? 'revise-operation' : code === 'replay-protected' ? 'inspect-result' : 'user-decision', replay: 'never' };
}
