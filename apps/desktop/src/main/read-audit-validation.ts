import { Value } from 'typebox/value';
import { RemoteReadAuditSchema, type OperationView } from '@cloudhelm/contracts';
import { redactOutput } from '@cloudhelm/core';

const fields = new Set(['id', 'taskId', 'hostId', 'kind', 'preview', 'status', 'readOnly', 'effects', 'createdAt',
  'completedAt', 'ruleId', 'loginAs', 'runAs', 'readAudit', 'promptVersion']);

/** Read audits use the same durable writer as mutations but can never mint a
 * process, an effect, an approval or a reconciliation. Content/error bodies are forbidden. */
export function validateReadAudit(operation: OperationView, prior?: OperationView): void {
  const fail = () => { throw new Error('Invalid read audit record'); };
  const audit = operation.readAudit;
  if (!Value.Check(RemoteReadAuditSchema, audit) || operation.kind !== 'read-file'
    || operation.readOnly !== true || operation.effects !== 'none'
    || Object.keys(operation).some((key) => !fields.has(key))) return fail();
  if (operation.promptVersion !== undefined && !/^[0-9A-Za-z.-]{1,32}$/.test(operation.promptVersion)) return fail();
  if (!audit || audit.path !== redactOutput(audit.path) || /[\u0000-\u001f\u007f]/u.test(audit.path)
    || operation.preview !== `Read ${audit.path}`) return fail();
  if (![operation.id, operation.taskId, operation.hostId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
    || !Number.isSafeInteger(operation.createdAt) || operation.createdAt < 0) return fail();
  const last = audit.events.at(-1)!;
  for (const event of audit.events) {
    if (event.phase === 'requested' && event.code !== 'requested'
      || event.phase === 'authorized' && event.code !== 'allowed'
      || event.phase === 'completed' && event.code !== 'completed'
      || ['denied', 'failed'].includes(event.phase) && ['requested', 'allowed', 'completed'].includes(event.code)) return fail();
  }
  const status = last.phase === 'requested' ? 'proposed' : last.phase === 'authorized' ? 'running'
    : last.phase === 'completed' ? 'succeeded' : last.phase === 'denied' ? 'denied' : 'failed';
  if (operation.status !== status || operation.ruleId !== `read-${last.code}`) return fail();
  if (prior && (prior.kind !== 'read-file' || !prior.readAudit || prior.createdAt !== operation.createdAt
    || prior.readAudit.path !== audit.path || prior.readAudit.policyRevision !== audit.policyRevision
    || prior.readAudit.events.length > audit.events.length
    || JSON.stringify(prior.readAudit.events) !== JSON.stringify(audit.events.slice(0, prior.readAudit.events.length)))) return fail();
}
