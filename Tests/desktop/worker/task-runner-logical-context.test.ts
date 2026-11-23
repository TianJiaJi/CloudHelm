import { expect, it, vi } from 'vitest';
import { TerminalManager } from '@cloudhelm/application';
import type { OperationExecutor, ProposedOperation } from '@cloudhelm/core';
import type { LogicalHostContext, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner-fixture.js';
import { fixtureMessageText, openAiFixture, type FixtureRequest } from './openai-sse-fixture.js';

const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'fixture', auth: 'password',
  status: 'connected', defaultMode: 'permissive', protectedPaths: [], policyRevision: 1 };
const task: TaskView = { id: 'task', goal: '在核验过的默认目录工作', hostIds: ['host'], localScopes: [], provider: 'cloudhelm-custom',
  modelId: 'fixture', status: 'paused', requestCount: 0, requestLimit: 100, createdAt: 1, updatedAt: 1 };
const toolText = (messages: FixtureRequest['messages'], id: string) =>
  fixtureMessageText(messages.find((message) => message.role === 'tool' && message.tool_call_id === id)!);

it('routes cwd-less operations through the verified explicit default and reports the working context', async () => {
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'set', name: 'set_default_cwd', arguments: { hostId: 'host', path: '/srv/app' } }] };
    if (requests === 2) {
      expect(toolText(request.messages, 'set')).toContain('Default cwd: /srv/app');
      expect(toolText(request.messages, 'set')).toContain('Revision: 0');
      return { calls: [{ id: 'run', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd' } }] };
    }
    expect(requests).toBe(3);
    const receipt = toolText(request.messages, 'run');
    expect(receipt).toContain('Working context: operationCwd=/srv/app, defaultCwd=/srv/app, revision=0.');
    return { text: '已在核验过的默认目录执行查询。' };
  });
  const terminal = new TerminalManager({ data: () => {}, state: () => {} });
  const executed: ProposedOperation[] = [];
  const execute = vi.fn(async (...[operation]: Parameters<OperationExecutor['execute']>) => {
    executed.push(structuredClone(operation));
    return { operationId: operation.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: '/srv/app\n', effects: 'none' as const };
  });
  const contexts: LogicalHostContext[] = [];
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const runner = new TaskRunner(structuredClone(task), [host], { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: fixture.baseUrl },
    [], terminal, { execute }, async () => terminal.open('host', { write: () => { throw new Error('No SSH input'); },
      resize() {}, close() {}, onData() {}, onClose() {} }, 'task', '/home/fixture'), {
      event: (event) => {
        if (event.type === 'logical-context') contexts.push(structuredClone(event.value));
        if (event.type === 'task-status' && ['answered', 'failed'].includes(event.status)) finish();
      }, requestApproval: async () => true, cancelApproval() {}
    }, undefined, undefined, undefined, undefined, undefined, [], undefined,
    async (_hostId, path) => path === '/srv/app' ? { canonical: '/srv/app' } : { failed: true as const });
  try {
    await runner.start(true);
    runner.message('把默认目录设为 /srv/app 后在其中执行 pwd');
    await settled;
    expect(fixture.errors).toEqual([]);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.scope).toMatchObject({ cwd: '/srv/app', contextRevision: 0 });
    expect(contexts).toEqual([{ version: 1, hostId: 'host', loginAs: 'fixture', defaultCwd: '/srv/app', revision: 0,
      source: 'explicit', updatedAt: expect.any(Number) }]);
  } finally { await fixture.close(); }
});

it('blocks cwd-less operations after a failed rebuild verification, keeps explicit cwd working and follows a fresh default', async () => {
  let requests = 0;
  const fixture = await openAiFixture(async (request) => {
    requests++;
    if (requests === 1) return { calls: [{ id: 'run1', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd' } }] };
    if (requests === 2) {
      expect(toolText(request.messages, 'run1')).toContain('set_default_cwd');
      expect(toolText(request.messages, 'run1')).toContain('未确认');
      return { calls: [{ id: 'run2', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd', cwd: '/tmp' } }] };
    }
    if (requests === 3) {
      expect(toolText(request.messages, 'run2')).toContain('Working context: operationCwd=/tmp, defaultCwd=unconfirmed, revision=4, rebuilt=unverified.');
      return { calls: [{ id: 'set', name: 'set_default_cwd', arguments: { hostId: 'host', path: '/srv/back' } }] };
    }
    if (requests === 4) {
      expect(toolText(request.messages, 'set')).toContain('Default cwd: /srv/back');
      expect(toolText(request.messages, 'set')).toContain('Revision: 5');
      return { calls: [{ id: 'run3', name: 'run_remote', arguments: { hostId: 'host', command: 'pwd' } }] };
    }
    expect(requests).toBe(5);
    expect(toolText(request.messages, 'run3')).toContain('Working context: operationCwd=/srv/back, defaultCwd=/srv/back, revision=5.');
    return { text: '已按新的核验默认目录完成查询。' };
  });
  const persisted: LogicalHostContext = { version: 1, hostId: 'host', loginAs: 'fixture', defaultCwd: '/srv/gone',
    revision: 3, source: 'explicit', restoreStatus: 'restored', updatedAt: 100 };
  const terminal = new TerminalManager({ data: () => {}, state: () => {} });
  const executed: ProposedOperation[] = [];
  const execute = vi.fn(async (...[operation]: Parameters<OperationExecutor['execute']>) => {
    executed.push(structuredClone(operation));
    return { operationId: operation.id, status: 'succeeded' as const, exitCode: 0, stdoutTail: 'ok\n', effects: 'none' as const };
  });
  const contexts: LogicalHostContext[] = [];
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const runner = new TaskRunner({ ...structuredClone(task), logicalContexts: [persisted] }, [host],
    { provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: fixture.baseUrl },
    [], terminal, { execute }, async () => terminal.open('host', { write: () => { throw new Error('No SSH input'); },
      resize() {}, close() {}, onData() {}, onClose() {} }, 'task', '/home/fixture'), {
      event: (event) => {
        if (event.type === 'logical-context') contexts.push(structuredClone(event.value));
        if (event.type === 'task-status' && ['answered', 'failed'].includes(event.status)) finish();
      }, requestApproval: async () => true, cancelApproval() {}
    }, undefined, undefined, undefined, undefined, undefined, [], undefined,
    async (_hostId, path) => path === '/srv/back' ? { canonical: '/srv/back' } : { failed: true as const });
  try {
    await runner.start(true);
    runner.message('执行 pwd；如果默认目录失效请先核验再恢复');
    await settled;
    expect(fixture.errors).toEqual([]);
    // The first cwd-less call never dispatched: its scope refused the unconfirmed default.
    expect(executed.map((operation) => operation.scope.cwd)).toEqual(['/tmp', '/srv/back']);
    expect(executed.map((operation) => operation.scope.contextRevision)).toEqual([4, 5]);
    expect(contexts.map((context) => [context.revision, context.defaultCwd, context.restoreStatus])).toEqual([
      [4, null, 'unverified'], [5, '/srv/back', undefined]]);
  } finally { await fixture.close(); }
});
