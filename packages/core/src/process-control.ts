import type { ProposedOperation } from './model.js';

type Control = NonNullable<Extract<ProposedOperation, { kind: 'command' }>['processControl']>;
/** Review text only. Dedicated execution must signal the existing bound channel,
 * never evaluate this text or perform a PID lookup in a new shell. */
export function processControlReviewCommand(control: Control): string { return `kill -INT -- -${control.pid}`; }
export function validProcessControl(operation: ProposedOperation): boolean {
  if (operation.kind !== 'command' || !operation.processControl) return true;
  const control = operation.processControl;
  return control.kind === 'interrupt' && Number.isSafeInteger(control.pid) && control.pid > 0 && control.pid <= 2147483647
    && Number.isSafeInteger(control.processSequence) && control.processSequence > 0
    && [control.jobId, control.targetOperationId, control.connectionId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/u.test(id))
    && Object.keys(control).every((key) => ['kind', 'jobId', 'targetOperationId', 'pid', 'processSequence', 'connectionId'].includes(key))
    && !operation.executionMode && !operation.privilege && !operation.outputExpectation && !operation.serviceUnit
    && operation.command === processControlReviewCommand(control);
}
