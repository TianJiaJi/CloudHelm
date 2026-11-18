import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { operationIntentKey, type OperationScope, type ProposedOperation } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import { taskOperationPreflight } from '../../../apps/desktop/src/worker/task-operation-preflight.js';

const scope = (): OperationScope => ({ taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'observe' });
const command = (id: string, text: string): Extract<ProposedOperation, { kind: 'command' }> => ({ id, kind: 'command', command: text, scope: scope() });
const view = (operation: ProposedOperation, status: OperationView['status'], ruleId?: string): OperationView => ({
  id: operation.id, taskId: 'task', hostId: 'host', kind: 'command',
  preview: operation.kind === 'command' ? operation.command : '', intentKey: operationIntentKey(operation),
  status, createdAt: 1, ...(ruleId ? { ruleId } : {}) });
const deps = (operations: OperationView[], replayProtected: string[] = []) => ({
  analyzer: new BashAnalyzer(), operations: () => operations, replayProtected: new Set(replayProtected) });

it('binds native transport only for eligible foreground operations and strips untrusted channel hints', async () => {
  const eligible = await taskOperationPreflight(command('simple', 'id -u'), deps([]));
  expect(eligible).toMatchObject({ operation: { executionChannel: 'native-exec' } });
  const forged = { ...command('forged', 'sudo id'), executionChannel: 'native-exec' as const };
  expect(await taskOperationPreflight(forged, deps([]))).not.toMatchObject({ operation: { executionChannel: 'native-exec' } });
  const background = { ...command('background', 'id -u'), executionMode: 'background' as const };
  expect(await taskOperationPreflight(background, deps([]))).not.toMatchObject({ operation: { executionChannel: 'native-exec' } });
});

it('refuses a PATH python3 command before review when a current connection proves it absent', async () => {
  const environment = { snapshot: () => ({ version: 1 as const, hostId: 'host', loginAs: 'user', connectionId: 'current',
    observedAt: Date.now(), status: 'observed' as const, readiness: { ssh: 'connected' as const,
      metadata: 'degraded' as const, execution: 'ready' as const },
    data: { os: 'Linux', distribution: 'centos', version: '7', architecture: 'x86_64', architectureFamily: 'x86_64',
      kernel: '3.10', username: 'user', uid: 1000, loginDirectory: '/', path: '/usr/bin:/bin',
      toolPresence: { python3: false }, source: 'shell' as const } }), refresh: async () => { throw new Error('No network in preflight'); } };
  expect(await taskOperationPreflight(command('python', 'python3 -c "print(1)"'), { ...deps([]), environment }))
    .toMatchObject({ isError: true, details: { code: 'capability-blocked', effects: 'none' } });
  expect(await taskOperationPreflight(command('shell', 'id -u'), { ...deps([]), environment }))
    .toMatchObject({ operation: { executionChannel: 'native-exec' } });
  expect(await taskOperationPreflight(command('explicit', '/opt/python3 -c "print(1)"'), { ...deps([]), environment }))
    .toMatchObject({ operation: { command: '/opt/python3 -c "print(1)"' } });
  expect(await taskOperationPreflight({ ...command('job', 'sleep 30'), executionMode: 'background' }, { ...deps([]), environment }))
    .toMatchObject({ isError: true, details: { code: 'capability-blocked', effects: 'none' } });
  expect(await taskOperationPreflight({ id: 'inspect', kind: 'inspect-file', path: '/srv/config', scope: scope() }, { ...deps([]), environment }))
    .toMatchObject({ isError: true, details: { code: 'capability-blocked', effects: 'none' } });
});

it('treats a repeated effect-free observation as a new observation, not a replayed change', async () => {
  for (const text of ['ss -ltnp', 'ip -br addr show', 'ping -c 1 -W 2 example.test']) {
    const first = command('first', text);
    const second = command('second', text);
    // Succeeded and still inside the round's replay-protected set: the conservative
    // case that previously blocked the second sandbox query with replay-protected.
    await expect(taskOperationPreflight(second, deps([view(first, 'succeeded')], [first.id])))
      .resolves.toMatchObject({ operation: second });
  }
});

it('still refuses to repeat a dispatched change, whatever status the round records', async () => {
  for (const status of ['running', 'proposed', 'approved', 'unknown', 'succeeded'] as const) {
    const first = command('first', 'systemctl restart nginx');
    const second = command('second', 'systemctl restart nginx');
    const result = await taskOperationPreflight(second, deps([view(first, status)], [first.id]));
    expect(result).toMatchObject({ isError: true, details: { code: 'replay-protected' } });
  }
});

it('lets a substantively new operation be reviewed again in the same round', async () => {
  const first = command('first', 'systemctl restart nginx');
  const second = command('second', 'systemctl restart postgresql');
  await expect(taskOperationPreflight(second, deps([view(first, 'succeeded')], [first.id])))
    .resolves.toMatchObject({ operation: second });
});

it('keeps a prior denial bound to its exact intent even for effect-free queries', async () => {
  const first = command('first', 'ss -ltnp');
  const second = command('second', 'ss -ltnp');
  const fixture = deps([view(first, 'denied', 'ai-review-deny')]);
  await expect(taskOperationPreflight(second, fixture))
    .resolves.toMatchObject({ isError: true, details: { code: 'prior-review-denied' } });
  await expect(taskOperationPreflight(second, fixture, true)).resolves.toMatchObject({ operation: second });
});

it('refuses a known-blocked write before review while read-only inspection continues', async () => {
  const write = command('write', 'systemctl restart nginx');
  const query = command('query', 'ss -ltnp');
  const blocked = (hostId: string) => hostId === 'host' ? 'Prior operation still unresolved.' : undefined;
  const depsWithBlocker = { ...deps([]), hostBlocked: blocked };
  await expect(taskOperationPreflight(write, depsWithBlocker))
    .resolves.toMatchObject({ isError: true, details: { code: 'unresolved-prior-operation', effects: 'none' } });
  await expect(taskOperationPreflight(query, depsWithBlocker)).resolves.toMatchObject({ operation: query });
});
