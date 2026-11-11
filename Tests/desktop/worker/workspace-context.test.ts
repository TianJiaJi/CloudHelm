import { expect, it, vi } from 'vitest';
import type { HostEnvironmentAccess, HostEnvironmentObservation } from '@cloudhelm/core';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createWorkspaceContextTools, environmentProjection, queryOperationHistory } from '../../../apps/desktop/src/worker/workspace-context.js';
import { createTaskPrompt } from '../../../apps/desktop/src/worker/task-prompt.js';
const host: RuntimeHost = { id: 'host', label: 'fixture', address: '127.0.0.1', port: 22, username: 'fixture', auth: 'password',
  status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
const observation: HostEnvironmentObservation = { version: 1, hostId: 'host', loginAs: 'fixture', connectionId: 'worker:1', observedAt: 100,
  status: 'observed', data: { os: 'Linux', distribution: 'debian', version: '12', kernel: '6.1', architecture: 'x86_64',
    username: 'fixture', uid: 1000, directory: '/home/fixture', tools: { systemctl: true }, source: 'python' },
  readiness: { ssh: 'connected', metadata: 'ready', execution: 'ready' } };
const environment: HostEnvironmentAccess = { snapshot: () => structuredClone(observation), refresh: vi.fn(async () => structuredClone(observation)) };
const op = (id: string, fields: Partial<OperationView> = {}): OperationView => ({ id, taskId: 'task', hostId: 'host',
  kind: 'command', preview: 'printf observation', status: 'succeeded', createdAt: 1, loginAs: 'fixture', runAs: 'fixture',
  executionContext: { version: 1, connectionId: 'worker:1', terminalId: 'terminal-A', terminalGeneration: 1 }, ...fields });
it('retrieves a change older than the last twelve operations across rounds and compacted history', () => {
  const port = op('opened-port', { preview: 'ufw allow 8080/tcp', readOnly: false, runAs: 'root', outputTail: 'Rule added', exitCode: 0, exitObserved: true });
  const all = [port, ...Array.from({ length: 80 }, (_, i) => op(`later-${i}`, { createdAt: 2 + i }))];
  const before = structuredClone(all);
  const found = queryOperationHistory('task', host, all, { hostId: 'host', query: '8080' }, environment);
  expect(found.operations).toHaveLength(1);
  expect(found.operations[0]).toMatchObject({ operationId: 'opened-port', runAs: 'root', terminalId: 'terminal-A',
    binding: 'same-connection-observation', currentState: 'not-established-by-history',
    observation: { status: 'succeeded', exitCode: 0 }, logRetrieval: { tool: 'read_operation_log' } });
  expect(found.authority).toContain('never replay'); expect(all).toEqual(before);
});
it('isolates conversation, authorized host and login, without granting historical root capability', () => {
  const records = [op('owned'), op('other-task', { taskId: 'other' }), op('other-host', { hostId: 'other' }), op('other-login', { loginAs: 'other' }), op('root-operation', { runAs: 'root' })];
  expect(queryOperationHistory('task', host, records, { hostId: 'host' }, environment).operations.map((item) => item.operationId)).toEqual(['root-operation', 'owned']);
  expect(() => queryOperationHistory('task', host, records, { hostId: 'other' })).toThrow('authorization');
});
it('marks earlier connection, unknown legacy binding and risk acceptance without rewriting observations', () => {
  const records = [op('old', { executionContext: { version: 1, connectionId: 'old-worker:1', terminalId: 'A', terminalGeneration: 1 } }),
    op('legacy', { executionContext: undefined, loginAs: undefined }), op('uncertain', { status: 'unknown', effects: 'possible',
      reconciledAt: 4, reconciliation: { kind: 'risk-accepted', at: 4, explanation: 'not proof' } })];
  const items = queryOperationHistory('task', host, records, { hostId: 'host' }, environment).operations;
  expect(items.find((item) => item.operationId === 'old')?.binding).toBe('historical-connection');
  expect(items.find((item) => item.operationId === 'legacy')?.binding).toBe('unknown-connection');
  expect(items.find((item) => item.operationId === 'uncertain')?.observation).toMatchObject({ status: 'unknown', effects: 'possible', reconciliation: { kind: 'risk-accepted', outcome: null } });
});
it('paginates without a last-twelve cutoff, refuses changed cursors and treats query text literally', () => {
  const records = Array.from({ length: 53 }, (_, i) => op(`op-${i}`, { createdAt: i, preview: i === 5 ? 'literal [x]' : 'normal' }));
  const ids: string[] = []; let beforeOperationId: string | undefined;
  do {
    const page = queryOperationHistory('task', host, records, { hostId: 'host', limit: 7, beforeOperationId });
    ids.push(...page.operations.map((item) => item.operationId)); beforeOperationId = page.nextBeforeOperationId ?? undefined;
  } while (beforeOperationId);
  expect(ids).toHaveLength(53); expect(new Set(ids).size).toBe(53);
  expect(queryOperationHistory('task', host, records, { hostId: 'host', query: '[x]' }).totalMatches).toBe(1);
  expect(() => queryOperationHistory('task', host, records, { hostId: 'host', beforeOperationId: 'foreign' })).toThrow('cursor');
});
it('bounds UTF-8 page bytes without losing operations when large excerpts shorten a page', () => {
  const records = Array.from({ length: 20 }, (_, i) => op(`large-${i}`, { createdAt: i, preview: '🙂'.repeat(2000),
    outputTail: '🙂'.repeat(2000), commandSource: { version: 1, cwd: '/srv/' + '🙂'.repeat(2000) } }));
  const ids: string[] = []; let beforeOperationId: string | undefined, pages = 0;
  do {
    const page = queryOperationHistory('task', host, records, { hostId: 'host', limit: 20, beforeOperationId });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(32768);
    expect(page.operations.every((item) => item.action.cwdTruncated)).toBe(true);
    ids.push(...page.operations.map((item) => item.operationId)); beforeOperationId = page.nextBeforeOperationId ?? undefined; pages++;
  } while (beforeOperationId);
  expect(pages).toBeGreaterThan(1); expect(ids).toHaveLength(20); expect(new Set(ids).size).toBe(20);
});
it('caps excerpts and redacts credentials without exposing arbitrary record properties', () => {
  const record = op('secret', { preview: 'password=synthetic-secret', outputTail: `token=secret-token\n${'x'.repeat(9000)}` });
  Object.assign(record, { rawSecret: 'never-project' });
  const found = queryOperationHistory('task', host, [record], { hostId: 'host' });
  expect(JSON.stringify(found)).not.toMatch(/synthetic-secret|secret-token|never-project/u);
  expect(found.operations[0]!.observation.outputExcerpt.length).toBeLessThanOrEqual(768);
});
it('marks stale/unknown host facts and generates context without network reads', () => {
  const refresh = vi.fn(async () => observation), access = { ...environment, refresh };
  expect(environmentProjection([host], access, 101)[0]?.freshness).toBe('recent-observation');
  expect(environmentProjection([host], access, 300100)[0]?.freshness).toBe('unknown-or-stale');
  expect(environmentProjection([host])[0]).toMatchObject({ status: 'unknown', observedAt: null });
  const task = { id: 'task', goal: 'check', hostIds: ['host'], localScopes: [] } as unknown as TaskView;
  const prompt = createTaskPrompt(task, [host], () => [], () => [], undefined, undefined, undefined, undefined, access)();
  expect(prompt).toContain('debian'); expect(prompt).toContain('query_operation_history'); expect(prompt).toContain('not root authorization');
  expect(refresh).not.toHaveBeenCalled();
});
it('rechecks tool authorization and cancellation instead of using discovery as permission', async () => {
  let allowed = true;
  const active = () => { if (!allowed) throw new Error('Paused'); };
  const refresh = vi.fn(async () => { allowed = false; return observation; });
  const tools = createWorkspaceContextTools('task', [host], () => [op('owned')], { ...environment, refresh }, active);
  const history = tools.find((tool) => tool.name === 'query_operation_history')!;
  await expect(history.execute('id', { hostId: 'other' } as never)).rejects.toThrow('authorization');
  const result = await history.execute('id', { hostId: 'host' } as never);
  expect(result.details).toMatchObject({ kind: 'operation-history', operations: [{ operationId: 'owned' }] });
  expect(refresh).not.toHaveBeenCalled();
  await expect(tools.find((tool) => tool.name === 'inspect_host_environment')!.execute('id', { hostId: 'host' } as never)).rejects.toThrow('Paused');
  await expect(history.execute('id', { hostId: 'host' } as never)).rejects.toThrow('Paused');
});
