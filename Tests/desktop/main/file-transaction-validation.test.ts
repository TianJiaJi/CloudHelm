import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { validateFileTransactionView } from '../../../apps/desktop/src/main/file-transaction-validation.js';
const operation = (): OperationView => ({ id: 'op', taskId: 'task', hostId: 'host', kind: 'write-file', preview: 'controlled edit',
  status: 'succeeded', createdAt: 1, verificationSource: { kind: 'file-write', path: '/srv/config', sha256: 'b'.repeat(64) },
  fileRecovery: { version: 1, directoryId: '11111111-1111-4111-8111-111111111111', path: '/srv/config',
    beforeSha256: 'a'.repeat(64), beforeMetadataDigest: 'c'.repeat(64), afterSha256: 'b'.repeat(64), afterMetadataDigest: 'd'.repeat(64) } });
it('accepts only a closed recovery receipt bound to the persisted file-write observation', () => {
  expect(() => validateFileTransactionView(operation())).not.toThrow();
  for (const change of [{ path: '/different' }, { afterSha256: 'e'.repeat(64) }, { path: '/srv/config\n' }, { password: 'synthetic' }]) {
    const value = operation(); Object.assign(value.fileRecovery!, change);
    expect(() => validateFileTransactionView(value)).toThrow('Invalid file recovery receipt');
  }
  const value = operation(); value.kind = 'command'; expect(() => validateFileTransactionView(value)).toThrow();
});
it('rejects raw private snapshots or mutating claims in inspect-file projection, including proposed state', () => {
  const value: OperationView = { id: 'read', taskId: 'task', hostId: 'host', kind: 'inspect-file', status: 'proposed', createdAt: 1,
    preview: 'Inspect file /srv/config (root identity)' };
  expect(() => validateFileTransactionView(value)).not.toThrow();
  for (const extra of [{ content: 'private' }, { snapshot: {} }, { contentBase64: 'cHJpdmF0ZQ==' }, { readOnly: false }, { effects: 'possible' }])
    expect(() => validateFileTransactionView(Object.assign({}, value, extra))).toThrow('Invalid private file inspection projection');
});
