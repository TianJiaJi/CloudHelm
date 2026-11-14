import { expect, it } from 'vitest';
import type { OperationView } from '@cloudhelm/contracts';
import { validateReadAudit } from '../../../apps/desktop/src/main/read-audit-validation.js';

const record = (): OperationView => ({ id: 'read', taskId: 'task', hostId: 'host', kind: 'read-file', preview: 'Read /srv/config',
  status: 'proposed', readOnly: true, effects: 'none', createdAt: 1, ruleId: 'read-requested',
  readAudit: { version: 1, path: '/srv/config', policyRevision: 1, events: [{ phase: 'requested', code: 'requested', at: 1 }] } });

it('rejects file/error bodies and process capabilities in the read audit channel', () => {
  expect(() => validateReadAudit(record())).not.toThrow();
  for (const payload of [{ outputTail: 'synthetic-secret' }, { reason: 'synthetic-raw-server-error' },
    { exitCode: 0 }, { readOnly: false }, { effects: 'possible' }]) {
    expect(() => validateReadAudit({ ...record(), ...payload } as OperationView)).toThrow('Invalid read audit');
  }
  const injected = record();
  Object.assign(injected.readAudit!, { content: 'synthetic-secret' });
  expect(() => validateReadAudit(injected)).toThrow('Invalid read audit');
});

it('requires an exact old-event prefix and keeps path and policy bindings immutable', () => {
  const prior = record(), next = record();
  next.status = 'running'; next.ruleId = 'read-allowed';
  next.readAudit!.events.push({ phase: 'authorized', code: 'allowed', at: 2 });
  expect(() => validateReadAudit(next, prior)).not.toThrow();
  const tampered = structuredClone(next); tampered.readAudit!.events[0]!.at = 0;
  expect(() => validateReadAudit(tampered, prior)).toThrow('Invalid read audit');
  const rebound = structuredClone(next); rebound.readAudit!.policyRevision = 2;
  expect(() => validateReadAudit(rebound, prior)).toThrow('Invalid read audit');
});
