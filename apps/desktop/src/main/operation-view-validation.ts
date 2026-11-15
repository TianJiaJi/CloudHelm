import { Value } from 'typebox/value';
import { Type } from 'typebox';
import type { OperationView } from '@cloudhelm/contracts';
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const schema = Type.Object({ version: Type.Literal(1), directoryId: Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' }),
  path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }), beforeSha256: hash, beforeMetadataDigest: hash,
  afterSha256: hash, afterMetadataDigest: hash }, { additionalProperties: false });
export function validateOperationView(operation: OperationView): void {
  if (operation.internal !== undefined && (operation.internal !== 'identity-probe' || operation.kind !== 'command'))
    throw new Error('Invalid internal preflight marker');
  const receipt = operation.fileRecovery;
  if (receipt && (!Value.Check(schema, receipt) || /[\u0000-\u001f\u007f]/u.test(receipt.path)
    || operation.kind !== 'write-file' || operation.verificationSource?.kind !== 'file-write'
    || operation.verificationSource.path !== receipt.path || operation.verificationSource.sha256 !== receipt.afterSha256))
    throw new Error('Invalid file recovery receipt');
  if (operation.kind === 'inspect-file' && (operation.readOnly === false || operation.effects === 'possible'
    || !operation.preview.startsWith('Inspect file ') || ['content', 'snapshot', 'contentBase64', 'fileInspection'].some((key) => key in operation)))
    throw new Error('Invalid private file inspection projection');
}
