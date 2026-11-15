import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, operationFingerprint, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { operationPreview } from '../../../apps/desktop/src/worker/operation-preview.js';
import { buildVerificationReport } from '../../../apps/desktop/src/worker/verification-facts.js';

const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', loginAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: 'root edit' };
const probe: Extract<ProposedOperation, { kind: 'command' }> = { id: 'probe', kind: 'command', command: 'id -u', probe: 'identity', scope };
const settings = { revision: 1, mode: 'ask' as const };

it('accepts only the exact backend identity probe shape and binds it into the fingerprint', async () => {
  const analysis = await new BashAnalyzer().analyze('id -u');
  expect(decideSafety(probe, settings, analysis)).toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
  expect(decideSafety({ ...probe, probe: undefined }, settings, analysis)).toMatchObject({ verdict: 'allow' });
  expect(operationFingerprint(probe)).not.toBe(operationFingerprint({ ...probe, probe: undefined }));
  for (const change of [{ command: 'id' }, { command: 'id -u; whoami' }, { privilege: 'root' as const },
    { executionMode: 'background' as const }, { serviceUnit: 'nginx' }, { scope: { ...scope, sessionId: 'legacy' } },
    { outputExpectation: { expectedOutput: '0' } }, { processControl: { kind: 'interrupt' as const, jobId: 'job', targetOperationId: 'op',
      pid: 1, processSequence: 1, connectionId: 'c' } }]) {
    expect(decideSafety({ ...probe, ...change } as never, settings)).toMatchObject({ verdict: 'error', ruleId: 'invalid-internal-probe' });
  }
});

it('labels the probe as backend preflight and keeps it out of the user-visible change summary', () => {
  expect(operationPreview(probe)).toContain('身份探测（后端自动预检，不计入业务完成）');
  const business: OperationView = { id: 'business', taskId: 'task', hostId: 'host', kind: 'command', preview: 'systemctl restart nginx',
    status: 'succeeded', readOnly: false, effects: 'possible', createdAt: 2 };
  const internal: OperationView = { id: 'probe', taskId: 'task', hostId: 'host', kind: 'command', internal: 'identity-probe',
    preview: '身份探测（后端自动预检，不计入业务完成）· id -u', status: 'succeeded', readOnly: true, effects: 'none', createdAt: 1 };
  const report = buildVerificationReport({ roundId: 'r', revision: 1, operations: [internal, business],
    all: [internal, business] });
  expect(report.changes).toHaveLength(1); expect(report.changes[0]).toContain('systemctl restart nginx');
  expect(JSON.stringify(report.changes)).not.toContain('身份探测');
  expect(report.facts?.operations).toHaveLength(2);
});
