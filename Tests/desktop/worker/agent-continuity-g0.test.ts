import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationResult, ProposedOperation } from '@cloudhelm/core';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture } from './openai-sse-fixture.js';

/** Loopback continuity contracts; no SSH, paid provider or OS credentials. */
async function scenario(first: string, result: (operation: ProposedOperation) => OperationResult, approved = true, tryWrite = false) {
  const commands: string[] = [];
  const toolMessages: string[] = [];
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'first', name: 'run_remote', arguments: {
      hostId: 'host', command: first, cwd: '/tmp' } }] };
    toolMessages.push(...request.messages.filter((message) => message.role === 'tool').map(fixtureMessageText));
    if (requests === 2) return { calls: [{ id: 'observe', name: 'run_remote', arguments: {
      hostId: 'host', command: 'df -h', cwd: '/tmp' } }] };
    if (requests === 3 && tryWrite) return { calls: [{ id: 'write', name: 'run_remote', arguments: {
      hostId: 'host', command: 'touch /tmp/g0-other', cwd: '/tmp' } }] };
    return { text: '依据已有事实结束；未重复原变更。' };
  });
  const task: TaskView = { id: 'g0-continuity', goal: '局部失败后只读调查，不重放原操作', hostIds: ['host'],
    localScopes: [], modelId: 'fixture', status: 'draft', requestCount: 0, requestLimit: 10, createdAt: 1, updatedAt: 1 };
  const host: RuntimeHost = { id: 'host', label: 'synthetic', address: '192.0.2.1', port: 22, username: 'user',
    auth: 'agent', status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const terminal = new TerminalManager({ data() {}, state() {} });
  const execute = vi.fn(async (operation: ProposedOperation): Promise<OperationResult> => {
    commands.push(operation.kind === 'command' ? operation.command : operation.kind);
    return commands.length === 1 ? result(operation) : {
      operationId: operation.id, status: 'succeeded', exitCode: 0, stdoutTail: 'fresh disk observation', effects: 'none'
    };
  });
  const requestApproval = vi.fn(async () => approved);
  const restrictions = new Set<string>();
  const runner = new TaskRunner(task, [host], { provider: 'cloudhelm-custom', modelId: 'fixture',
    apiKey: 'g0-synthetic-key', baseUrl: fixture.baseUrl }, [], terminal, { execute },
  async () => terminal.open(host.id, { write() { throw new Error('No SSH or credential channel in G0 fixture'); },
    resize() {}, close() {}, onData() {}, onClose() {} }, task.id, '/tmp'),
  { event(event) {
    if (event.type === 'execution' && event.value.diagnosisRestriction) restrictions.add(event.value.diagnosisRestriction);
  }, requestApproval, cancelApproval() {} });
  try {
    await runner.start();
    return { commands, requests, toolMessages, restrictions: [...restrictions], status: task.status, errors: [...fixture.errors], approvals: requestApproval.mock.calls.length };
  } finally { runner.dispose(); await fixture.close(); }
}

it('G0-C01: an effect-free failed query reaches the model and permits a different observation', async () => {
  const observed = await scenario('stat /tmp/g0-missing', (operation) => ({ operationId: operation.id,
    status: 'failed', exitCode: 1, effects: 'none', stdoutTail: 'synthetic path missing' }));
  expect(observed.errors).toEqual([]);
  expect(observed.commands).toEqual(['stat /tmp/g0-missing', 'df -h']);
  expect(observed.requests).toBe(3);
  expect(observed.restrictions).toEqual([]);
  expect(observed.status).toBe('answered');
  expect(observed.toolMessages.join('\n')).toContain('synthetic path missing');
});

it('G0-C02: a user denial allows unrelated diagnosis but prevents further writes in the turn', async () => {
  const observed = await scenario('systemctl restart demo.service', (operation) => ({ operationId: operation.id,
    status: 'succeeded', exitCode: 0, effects: 'none', stdoutTail: 'must not execute denied action' }), false, true);
  expect(observed).toMatchObject({ errors: [], approvals: 1, commands: ['df -h'], requests: 4, status: 'answered' });
  expect(observed.toolMessages.join('\n')).toContain('continuation-read-only');
  expect(observed.restrictions).toEqual(['user-denied']);
});

it.each(['failed', 'unknown'] as const)('G0-C03: %s mutation allows diagnosis without permitting writes or clearing verification', async (status) => {
  const observed = await scenario('mkdir /tmp/g0-work', (operation) => ({ operationId: operation.id,
    status, exitCode: status === 'failed' ? 1 : undefined, effects: 'possible', stdoutTail: 'synthetic partially applied change' }), true, true);
  expect(observed).toMatchObject({ errors: [], commands: ['mkdir /tmp/g0-work', 'df -h'], requests: 4, status: 'paused' });
  expect(observed.toolMessages.join('\n')).toContain('unresolved-prior-operation');
  expect(observed.restrictions).toEqual(['outcome-unverified']);
});
