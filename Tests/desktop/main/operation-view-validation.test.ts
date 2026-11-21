import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { validateOperationView } from '../../../apps/desktop/src/main/operation-view-validation.js';
const operation = (): OperationView => ({ id: 'op', taskId: 'task', hostId: 'host', kind: 'write-file', preview: 'controlled edit',
  status: 'succeeded', createdAt: 1, verificationSource: { kind: 'file-write', path: '/srv/config', sha256: 'b'.repeat(64) },
  fileRecovery: { version: 1, directoryId: '11111111-1111-4111-8111-111111111111', path: '/srv/config',
    beforeSha256: 'a'.repeat(64), beforeMetadataDigest: 'c'.repeat(64), afterSha256: 'b'.repeat(64), afterMetadataDigest: 'd'.repeat(64) } });
it('rejects a forged internal preflight marker on a non-command or unknown kind', () => {
  const probe = { id: 'probe', taskId: 'task', hostId: 'host', kind: 'command' as const, preview: '身份探测 · id -u',
    status: 'succeeded' as const, createdAt: 1, internal: 'identity-probe' as const };
  expect(() => validateOperationView(probe)).not.toThrow();
  expect(() => validateOperationView({ ...probe, internal: 'other' as never })).toThrow('Invalid internal preflight marker');
  expect(() => validateOperationView({ ...operation(), internal: 'identity-probe' })).toThrow('Invalid internal preflight marker');
});
it('binds the recovery probe to a command and its unknown target, never a forged marker', () => {
  const probe = { id: 'probe', taskId: 'task', hostId: 'host', kind: 'command' as const, preview: '结果核验探测 · systemctl show',
    status: 'succeeded' as const, createdAt: 1, internal: 'recovery-probe' as const,
    recoveryProbeTarget: '22222222-2222-4222-8222-222222222222' };
  expect(() => validateOperationView(probe)).not.toThrow();
  for (const change of [{ recoveryProbeTarget: 'not-a-uuid' }, { recoveryProbeTarget: undefined }, { kind: 'write-file' as const },
    { internal: 'identity-probe' as const }]) expect(() => validateOperationView({ ...probe, ...change })).toThrow('Invalid internal preflight marker');
  expect(() => validateOperationView({ ...operation(), internal: 'recovery-probe', recoveryProbeTarget: '22222222-2222-4222-8222-222222222222' }))
    .toThrow('Invalid internal preflight marker');
});
it('accepts only a well-formed delegation identity and a bounded tool call trace', () => {
  const command: OperationView = { id: 'native', taskId: 'task', hostId: 'host', kind: 'command',
    preview: 'id -u', status: 'proposed', createdAt: 1 };
  expect(() => validateOperationView({ ...command, delegationId: '33333333-3333-4333-8333-333333333333', toolCallId: 'call_1' })).not.toThrow();
  expect(() => validateOperationView({ ...command, delegationId: 'delegation-1' })).toThrow('Invalid delegation identity');
  expect(() => validateOperationView({ ...command, toolCallId: '' })).toThrow('Invalid tool call trace');
  expect(() => validateOperationView({ ...command, toolCallId: 'x'.repeat(201) })).toThrow('Invalid tool call trace');
});
it('persists only a command-bound native route, never a forged file or unknown transport', () => {
  const command: OperationView = { id: 'native', taskId: 'task', hostId: 'host', kind: 'command',
    preview: 'id -u', status: 'proposed', createdAt: 1, executionChannel: 'native-exec' };
  expect(() => validateOperationView(command)).not.toThrow();
  expect(() => validateOperationView({ ...command, kind: 'write-file' })).toThrow('Invalid execution channel projection');
  expect(() => validateOperationView({ ...command, executionChannel: 'legacy' as never })).toThrow('Invalid execution channel projection');
});
it('persists the backend-owned native background route only on a command projection', () => {
  const command: OperationView = { id: 'background', taskId: 'task', hostId: 'host', kind: 'command',
    preview: 'sleep 300', status: 'proposed', createdAt: 1, executionChannel: 'native-background' };
  expect(() => validateOperationView(command)).not.toThrow();
  expect(() => validateOperationView({ ...command, kind: 'inspect-file' })).toThrow('Invalid execution channel projection');
  expect(() => validateOperationView({ ...command, executionChannel: 'native-exec-2' as never })).toThrow('Invalid execution channel projection');
});
it('accepts only a closed recovery receipt bound to the persisted file-write observation', () => {
  expect(() => validateOperationView(operation())).not.toThrow();
  for (const change of [{ path: '/different' }, { afterSha256: 'e'.repeat(64) }, { path: '/srv/config\n' }, { password: 'synthetic' }]) {
    const value = operation(); Object.assign(value.fileRecovery!, change);
    expect(() => validateOperationView(value)).toThrow('Invalid file recovery receipt');
  }
  const value = operation(); value.kind = 'command'; expect(() => validateOperationView(value)).toThrow();
});
it('rejects raw private snapshots or mutating claims in inspect-file projection, including proposed state', () => {
  const value: OperationView = { id: 'read', taskId: 'task', hostId: 'host', kind: 'inspect-file', status: 'proposed', createdAt: 1,
    preview: 'Inspect file /srv/config (root identity)' };
  expect(() => validateOperationView(value)).not.toThrow();
  for (const extra of [{ content: 'private' }, { snapshot: {} }, { contentBase64: 'cHJpdmF0ZQ==' }, { readOnly: false }, { effects: 'possible' }])
    expect(() => validateOperationView(Object.assign({}, value, extra))).toThrow('Invalid private file inspection projection');
});
