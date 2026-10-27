import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashAnalyzer, SqliteStore } from '@cloudhelm/adapters';
import { operationIntentKey, type ProposedOperation } from '@cloudhelm/core';
import { operationNeedsVerification, type HostView, type OperationView, type TaskView } from '@cloudhelm/contracts';
import { AppState } from './app-state.js';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const host: HostView = { id: 'host', label: 'fixture', address: 'fixture.invalid', port: 22, username: 'tester',
  auth: 'password', status: 'disconnected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1 };
const task = (patch: Partial<TaskView> = {}): TaskView => ({ id: 'task', goal: 'inspect only', hostIds: ['host'],
  localScopes: [], status: 'answered', modelId: 'fixture', requestCount: 4, requestLimit: 100,
  createdAt: 1, updatedAt: 2, resumeReason: 'report', summary: '原报告提示',
  verificationState: { status: 'unverified', reasonCode: 'report-missing', operationIds: ['query'] }, ...patch });
function query(patch: Partial<OperationView> = {}, cwd = '/home/tester'): OperationView {
  const command = patch.preview ?? "docker images --format '{{.Repository}}:{{.Tag}}|{{.Size}}'";
  const source: ProposedOperation = { id: patch.id ?? 'query', kind: 'command', command, scope: {
    taskId: 'task', hostId: 'host', cwd, runAs: 'tester', loginAs: 'tester', terminalId: 'terminal',
    terminalGeneration: 1, policyRevision: 1, goal: 'inspect', protectedPaths: [], allowedWorkingRoots: []
  } };
  return { id: 'query', taskId: 'task', hostId: 'host', kind: 'command', preview: command, status: 'succeeded',
    readOnly: false, effects: 'possible', exitCode: 0, createdAt: 1, runAs: 'tester', loginAs: 'tester',
    intentKey: operationIntentKey(source), ...patch };
}
function setup(operations = [query()], tasks = [task()], file = ':memory:') {
  const store = new SqliteStore(file);
  cleanups.push(() => store.close());
  store.put('hosts', host.id, host);
  for (const value of tasks) store.put('tasks', value.id, value);
  for (const value of operations) store.put('operations', value.id, value);
  const state = new AppState(store, () => {});
  cleanups.push(() => state.close());
  return { state, store };
}

it('repairs fingerprint-proven completed queries and only their pending report state atomically', async () => {
  const accepted = query({ id: 'accepted', status: 'failed', exitCode: 1, authentication: 'succeeded',
    failureKind: 'permission-denied', reconciledAt: 12,
    reconciliation: { kind: 'risk-accepted', at: 12, explanation: '保留原风险记录', sourceTaskId: 'task' } });
  const { state, store } = setup([query(), accepted]);
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  for (const op of state.snapshot().operations) expect(op).toMatchObject({ readOnly: true, effects: 'none' });
  expect(store.get('operations', 'accepted')).toMatchObject({ ...accepted, readOnly: true, effects: 'none' });
  expect(state.getTask('task')).toMatchObject({ status: 'answered', requestCount: 4, updatedAt: 2 });
  expect(state.getTask('task').verificationState).toBeUndefined();
  expect(state.getTask('task').resumeReason).toBeUndefined();
  expect(state.getTask('task').summary).toBeUndefined();
  const analyze = vi.fn(async () => { throw new Error('must not reparse a committed repair'); });
  await state.normalizeHistoricalQueries({ analyze });
  expect(analyze).not.toHaveBeenCalled();
  expect(state.snapshot().operations.filter(operationNeedsVerification)).toEqual([]);
});

it.each([
  ['missing fingerprint', { intentKey: undefined }],
  ['truncated but valid preview', { preview: 'docker images', intentKey: query({ preview: 'docker images; touch /tmp/write' }).intentKey }],
  ['redacted', { preview: 'ls [REDACTED]' }],
  ['unmasked secret', { preview: 'ls password=private-fixture-value' }],
  ['unknown outcome', { status: 'unknown', exitCode: 0 }],
  ['running', { status: 'running', exitCode: 0 }],
  ['missing exit', { exitCode: undefined }],
  ['negative exit', { exitCode: -1 }],
  ['fractional exit', { exitCode: 0.5 }],
  ['unknown identity', { runAs: undefined }],
  ['different login', { loginAs: 'foreign' }],
  ['different host', { hostId: 'foreign' }],
  ['unknown task', { taskId: 'foreign' }],
  ['real mutation', { preview: 'docker images; touch /tmp/write' }],
  ['expansion', { preview: 'docker images $(touch /tmp/write)' }],
  ['daemon override', { preview: 'docker -H tcp://elsewhere images' }]
] satisfies Array<[string, Partial<OperationView>]>)('does not repair %s', async (_name, patch) => {
  for (const status of ['succeeded', 'failed'] as const) {
    const { state, store } = setup([query({ status, exitCode: status === 'succeeded' ? 0 : 1, ...patch })]);
    const before = state.snapshot();
    const saved = store.get('operations', 'query');
    await state.normalizeHistoricalQueries(new BashAnalyzer());
    expect(state.snapshot()).toEqual(before);
    expect(store.get('operations', 'query')).toEqual(saved);
  }
});

it('leaves an unprovable non-default directory unchanged rather than guessing completeness', async () => {
  const { state } = setup([query({}, '/srv/custom/deep')]);
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.snapshot().operations[0]?.readOnly).toBe(false);
});

it('uses a versioned captured cwd only when the existing full-command fingerprint matches it', async () => {
  const cwd = '/srv/custom/deep';
  const good = query({ commandSource: { version: 1, cwd } }, cwd);
  const { state } = setup([good]);
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.snapshot().operations[0]?.readOnly).toBe(true);
  for (const source of [{ version: 1, cwd: '/' }, { version: 2, cwd }]) {
    const mismatched = setup([{ ...good, commandSource: source as OperationView['commandSource'] }]);
    await mismatched.state.normalizeHistoricalQueries(new BashAnalyzer());
    expect(mismatched.state.snapshot().operations[0]?.readOnly).toBe(false);
  }
});

it('never clears another conversation report by a foreign operation ID', async () => {
  const foreign = task({ id: 'foreign' });
  const { state } = setup([query()], [task(), foreign]);
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.getTask('foreign').verificationState).toEqual(foreign.verificationState);
  expect(state.getTask('foreign').resumeReason).toBe('report');
});

it('keeps mixed writes, foreign missing IDs and old stops conservative', async () => {
  const write = query({ id: 'write', preview: 'touch /tmp/write' });
  const mixed = task({ verificationState: { status: 'unverified', reasonCode: 'report-missing', operationIds: ['query', 'write', 'missing'] } });
  const { state } = setup([query(), write], [mixed]);
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.getTask('task').verificationState?.operationIds).toEqual(['write', 'missing']);
  expect(state.getTask('task').resumeReason).toBe('report');
  expect(state.getTask('task').report).toBeUndefined();
  for (const status of ['paused', 'failed'] as const) {
    const stopped = setup([query({ interruption: { source: 'stop-button', requestedAt: 3, operationIds: ['query'] } })],
      [task({ status, resumeReason: 'interrupted', summary: '用户停止，不能自动继续' })]);
    stopped.store.put('messages', 'answer', { taskId: 'task', role: 'agent', text: '已完成全部工作', createdAt: 4 });
    await stopped.state.normalizeHistoricalQueries(new BashAnalyzer());
    expect(stopped.state.getTask('task')).toMatchObject({ status, resumeReason: 'interrupted', summary: '用户停止，不能自动继续' });
    expect(stopped.state.snapshot().operations[0]?.interruption?.source).toBe('stop-button');
  }
});

it('does not hide untracked writes or unresolved outcomes when the pending list contains only the query', async () => {
  for (const status of ['succeeded', 'unknown'] as const) {
    const { state, store } = setup([query(), query({ id: 'write', preview: 'touch /tmp/write', status })]);
    await state.normalizeHistoricalQueries(new BashAnalyzer());
    expect(state.getTask('task').resumeReason).toBe('report');
    expect(state.getTask('task').verificationState?.status).toBe('unverified');
    if (status === 'succeeded') {
      expect(state.getTask('task').verificationState?.operationIds).toContain('write');
      expect(store.get<TaskView>('tasks', 'task')?.verificationState?.operationIds).toContain('write');
    }
  }
});

it('retries parser failures after restart without marking the item repaired', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-history-repair-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'records.sqlite');
  const { state, store } = setup(undefined, undefined, file);
  await state.normalizeHistoricalQueries({ analyze: async () => { throw new Error('parser unavailable'); } });
  expect(store.get('operations', 'query')).toMatchObject({ readOnly: false });
  state.close(); cleanups.pop(); store.close(); cleanups.pop();
  const reopened = new SqliteStore(file);
  cleanups.push(() => reopened.close());
  const restored = new AppState(reopened, () => {});
  cleanups.push(() => restored.close());
  await restored.normalizeHistoricalQueries(new BashAnalyzer());
  expect(restored.snapshot().operations[0]).toMatchObject({ readOnly: true, effects: 'none' });
  expect(reopened.get<TaskView>('tasks', 'task')?.verificationState).toBeUndefined();
});

it('rolls back operation, task and repair marker together if any durable write fails', async () => {
  const { state, store } = setup();
  const before = state.snapshot();
  const put = store.put.bind(store);
  const fail = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
    if (bucket === 'tasks') throw new Error('simulated disk failure');
    put(bucket, id, value);
  });
  await expect(state.normalizeHistoricalQueries(new BashAnalyzer())).rejects.toThrow('simulated disk failure');
  expect(state.snapshot()).toEqual(before);
  expect(store.get('operations', 'query')).toMatchObject({ readOnly: false });
  fail.mockRestore();
  await state.normalizeHistoricalQueries(new BashAnalyzer());
  expect(state.snapshot().operations[0]?.readOnly).toBe(true);
});

it('rejects a stale repair if operation or task state changes while the parser is awaited', async () => {
  const { state, store } = setup();
  const parser = new BashAnalyzer();
  await expect(state.normalizeHistoricalQueries({ analyze: async (command) => {
    state.record({ type: 'task-status', taskId: 'task', status: 'paused', resumeReason: 'interrupted', summary: '新停止' });
    return parser.analyze(command);
  } })).rejects.toThrow(/changed|变化/u);
  expect(store.get('operations', 'query')).toMatchObject({ readOnly: false });
  expect(state.getTask('task')).toMatchObject({ status: 'paused', summary: '新停止' });
});
