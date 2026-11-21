import { Value } from 'typebox/value';
import { Type } from 'typebox';
import type { OperationView } from '@cloudhelm/contracts';
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const schema = Type.Object({ version: Type.Literal(1), directoryId: Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' }),
  path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }), beforeSha256: hash, beforeMetadataDigest: hash,
  afterSha256: hash, afterMetadataDigest: hash }, { additionalProperties: false });
const uuid = '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
export function validateOperationView(operation: OperationView): void {
  if (operation.internal !== undefined && (operation.kind !== 'command'
    || (operation.internal === 'identity-probe' ? operation.recoveryProbeTarget !== undefined
      : operation.internal === 'recovery-probe' ? !new RegExp(`^${uuid}$`, 'u').test(operation.recoveryProbeTarget ?? '') : true)))
    throw new Error('Invalid internal preflight marker');
  if (operation.delegationId !== undefined && !new RegExp(`^${uuid}$`, 'u').test(operation.delegationId))
    throw new Error('Invalid delegation identity');
  if (operation.toolCallId !== undefined && (operation.toolCallId.length < 1 || operation.toolCallId.length > 200))
    throw new Error('Invalid tool call trace');
  if (operation.executionChannel !== undefined && (operation.kind !== 'command'
    || !['native-exec', 'native-pty', 'native-background'].includes(operation.executionChannel)))
    throw new Error('Invalid execution channel projection');
  const receipt = operation.fileRecovery;
  if (receipt && (!Value.Check(schema, receipt) || /[\u0000-\u001f\u007f]/u.test(receipt.path)
    || operation.kind !== 'write-file' || operation.verificationSource?.kind !== 'file-write'
    || operation.verificationSource.path !== receipt.path || operation.verificationSource.sha256 !== receipt.afterSha256))
    throw new Error('Invalid file recovery receipt');
  if (operation.kind === 'inspect-file' && (operation.readOnly === false || operation.effects === 'possible'
    || !operation.preview.startsWith('Inspect file ') || ['content', 'snapshot', 'contentBase64', 'fileInspection'].some((key) => key in operation)))
    throw new Error('Invalid private file inspection projection');
}
