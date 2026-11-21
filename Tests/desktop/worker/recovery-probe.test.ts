import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, serviceQuery, type OperationResult, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import { appendProbeFindings, buildRecoveryProbe, probeEvidence } from '../../../apps/desktop/src/worker/recovery-probe.js';
import { operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';

const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', loginAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/'], protectedPaths: [], goal: 'restart nginx' };
const settings = { revision: 1, mode: 'ask' as const };
const unknown: Extract<ProposedOperation, { kind: 'command' }> = { id: '22222222-2222-4222-8222-222222222222', kind: 'command',
  command: 'systemctl restart nginx.service', serviceUnit: 'nginx.service', delegationId: '11111111-1111-4111-8111-111111111111',
  toolCallId: 'toolcall-1', scope };

it('builds the whitelisted recovery probe from a service unit and passes the safety gate', async () => {
  const probe = buildRecoveryProbe(unknown, scope);
  expect(probe).toBeDefined();
  if (probe?.kind !== 'command') throw new Error('probe must be a command');
  expect(probe.command).toBe(serviceQuery('nginx.service'));
  expect(probe.command).not.toBe(unknown.command);
  expect(probe.probe).toBe('recovery');
  expect(probe.recoveryTarget).toBe(unknown.id);
  expect(probe.delegationId).toBe(unknown.delegationId);
  expect(probe.toolCallId).toBeUndefined();
  expect(probe.serviceUnit).toBeUndefined();
  expect(probe.privilege).toBeUndefined();
  expect(probe.executionMode).toBeUndefined();
  expect(probe.outputExpectation).toBeUndefined();
  expect(probe.id).not.toBe(unknown.id);
  expect(probe.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
  expect(probe.scope).not.toBe(scope);
  const analysis = await new BashAnalyzer().analyze(probe.command);
  expect(decideSafety(probe, settings, analysis)).toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
});

it('declines to probe without a template: no unit, no command, nested probe, invalid unit', () => {
  expect(buildRecoveryProbe(unknown, scope)).toBeDefined();
  const { serviceUnit, ...withoutUnit } = unknown;
  expect(serviceUnit).toBe('nginx.service');
  expect(buildRecoveryProbe(withoutUnit, scope)).toBeUndefined();
  expect(buildRecoveryProbe({ ...unknown, probe: 'identity' }, scope)).toBeUndefined();
  expect(buildRecoveryProbe({ ...unknown, probe: 'recovery' }, scope)).toBeUndefined();
  expect(buildRecoveryProbe({ ...unknown, serviceUnit: 'nginx' }, scope)).toBeUndefined();
  expect(buildRecoveryProbe({ ...unknown, serviceUnit: '../evil.service' }, scope)).toBeUndefined();
  expect(buildRecoveryProbe({ id: 'file', kind: 'write-file', path: '/etc/nginx/nginx.conf', content: 'x', scope }, scope)).toBeUndefined();
});

it('parses bounded probe evidence with normalized exit code', () => {
  const result: OperationResult = { operationId: 'probe-op', status: 'succeeded', exitCode: 0,
    stdoutTail: 'Id=nginx.service\nActiveState=active\nSubState=running\nUntrusted=noise\n' };
  const evidence = probeEvidence(result);
  expect(evidence.operationId).toBe('probe-op');
  expect(evidence.status).toBe('succeeded');
  expect(evidence.exitCode).toBe(0);
  expect(evidence.observations).toEqual({ Id: 'nginx.service', ActiveState: 'active', SubState: 'running' });
  expect(probeEvidence({ ...result, exitCode: undefined, status: 'unknown' }).exitCode).toBeNull();
  expect(probeEvidence({ ...result, stdoutTail: 'ActiveState=' + 'a'.repeat(500) }).observations.ActiveState).toHaveLength(200);
});

it('appends probe findings without changing the existing feedback shape', () => {
  const result: OperationResult = { operationId: unknown.id, status: 'unknown', stdoutTail: '' };
  const feedback = operationToolResult(result, 'host', false, scope);
  const evidence = probeEvidence({ operationId: 'probe-op', status: 'succeeded', exitCode: 0,
    stdoutTail: 'ActiveState=active\nSubState=running\n' });
  const augmented = appendProbeFindings(feedback, evidence);
  expect(augmented).not.toBe(feedback);
  expect(augmented.result).toBe(feedback.result);
  expect(augmented.readOnly).toBe(feedback.readOnly);
  expect(augmented.isError).toBe(feedback.isError);
  expect(augmented.structuredContent).toEqual({ ...feedback.structuredContent, recoveryProbe: evidence });
  const text = augmented.content[0]?.type === 'text' ? augmented.content[0].text : '';
  expect(text.startsWith(feedback.content[0]?.type === 'text' ? feedback.content[0].text : '')).toBe(true);
  expect(text).toContain('Recovery probe (read-only systemd query): operationId=probe-op, status=succeeded, exit=0, ActiveState=active, SubState=running');
  expect(text).toContain('record_reconciled_result');
});
