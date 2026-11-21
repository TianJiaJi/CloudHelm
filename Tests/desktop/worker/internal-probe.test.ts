import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, operationFingerprint, serviceQuery, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
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

it('accepts only the exact backend recovery probe shape and binds it into the fingerprint', async () => {
  const recovery: Extract<ProposedOperation, { kind: 'command' }> = { id: 'recovery-probe', kind: 'command',
    command: serviceQuery('nginx.service'), probe: 'recovery', recoveryTarget: '22222222-2222-4222-8222-222222222222', scope };
  const analysis = await new BashAnalyzer().analyze(recovery.command);
  expect(decideSafety(recovery, settings, analysis)).toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
  for (const change of [{ command: 'id -u' }, { command: `${serviceQuery('nginx.service')}; whoami` },
    { command: serviceQuery('nginx.service').replace('--no-pager', '--no-pager --plain') },
    { command: 'systemctl show --no-pager --property=ActiveState -- nginx.service' },
    { recoveryTarget: 'not-a-uuid' }, { recoveryTarget: undefined },
    { probe: 'identity' as const }, { privilege: 'root' as const }, { executionMode: 'background' as const },
    { serviceUnit: 'nginx.service' }, { scope: { ...scope, sessionId: 'legacy' } },
    { outputExpectation: { expectedOutput: '0' } }]) {
    expect(decideSafety({ ...recovery, ...change } as never, settings)).toMatchObject({ verdict: 'error', ruleId: 'invalid-internal-probe' });
  }
  expect(operationFingerprint(recovery)).not.toBe(operationFingerprint({ ...recovery, recoveryTarget: '33333333-3333-4333-8333-333333333333' }));
});

it('labels the probe as backend preflight and keeps it out of the user-visible change summary', () => {
  expect(operationPreview(probe)).toContain('身份探测（后端自动预检，不计入业务完成）');
  expect(operationPreview({ ...probe, probe: 'recovery', recoveryTarget: '22222222-2222-4222-8222-222222222222',
    command: serviceQuery('nginx.service') })).toContain('结果核验探测（后端只读采集证据，不计入业务完成）');
  const business: OperationView = { id: 'business', taskId: 'task', hostId: 'host', kind: 'command', preview: 'systemctl restart nginx',
    status: 'succeeded', readOnly: false, effects: 'possible', createdAt: 2 };
  const internal: OperationView = { id: 'probe', taskId: 'task', hostId: 'host', kind: 'command', internal: 'identity-probe',
    preview: '身份探测（后端自动预检，不计入业务完成）· id -u', status: 'succeeded', readOnly: true, effects: 'none', createdAt: 1 };
  const recovery: OperationView = { id: 'recovery-probe', taskId: 'task', hostId: 'host', kind: 'command', internal: 'recovery-probe',
    recoveryProbeTarget: '22222222-2222-4222-8222-222222222222',
    preview: '结果核验探测（后端只读采集证据，不计入业务完成）· systemctl show --no-pager --property=Id -- nginx.service',
    status: 'succeeded', readOnly: true, effects: 'none', createdAt: 3 };
  const report = buildVerificationReport({ roundId: 'r', revision: 1, operations: [internal, recovery, business],
    all: [internal, recovery, business] });
  expect(report.changes).toHaveLength(1); expect(report.changes[0]).toContain('systemctl restart nginx');
  expect(JSON.stringify(report.changes)).not.toContain('身份探测');
  expect(JSON.stringify(report.changes)).not.toContain('结果核验探测');
  expect(report.facts?.operations).toHaveLength(3);
});
