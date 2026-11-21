import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../packages/adapters/src/sqlite-store.js';

const stores: SqliteStore[] = [];
const tempDirs: string[] = [];
function open(): SqliteStore {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('migrates old host protection and captures each existing conversation effective review mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-policy-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  put.run('hosts', 'old', JSON.stringify({ id: 'old', defaultMode: 'permissive', protectedPaths: ['/srv/secret'] }));
  put.run('tasks', 'task', JSON.stringify({ id: 'task', hostIds: ['old'] }));
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  expect(migrated.get('hosts', 'old')).toMatchObject({ protectedReadPaths: ['/srv/secret'],
    protectedWritePaths: ['/srv/secret'] });
  expect(migrated.get('tasks', 'task')).toMatchObject({ reviewModesByHost: { old: 'permissive' }, reviewRevision: 1 });
  migrated.close(); stores.pop();
  const reopened = new SqliteStore(file);
  stores.push(reopened);
  expect(reopened.get('tasks', 'task')).toMatchObject({ reviewModesByHost: { old: 'permissive' } });
});

it('preserves unknown legacy outcomes instead of granting capabilities from previews during upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-read-only-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1), (6, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  put.run('operations', 'query', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'df -h' }));
  put.run('operations', 'unsafe', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'df -h && rm /tmp/data' }));
  put.run('operations', 'other', JSON.stringify({ kind: 'command', status: 'unknown', preview: 'docker ps --format "{{.Names}}"' }));
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'query')?.readOnly).toBeUndefined();
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'unsafe')?.readOnly).toBeUndefined();
  expect(migrated.get<{ readOnly?: boolean }>('operations', 'other')?.readOnly).toBeUndefined();
});

it('migrates completed legacy reviews without inferring completion from old assistant text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-completion-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4, 1), (5, 1), (6, 1), (7, 1);`);
  const put = legacy.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)');
  for (const status of ['ready-for-review', 'accepted']) put.run('tasks', status, JSON.stringify({ status, report: { summary: '已验证' } }));
  put.run('tasks', 'legacy-unsafe', JSON.stringify({ status: 'accepted' }));
  put.run('operations', 'legacy-unsafe', JSON.stringify({ taskId: 'legacy-unsafe', readOnly: false, status: 'unknown' }));
  const summary = '已执行操作，但验证证据尚不完整。请继续核验后验收。';
  for (const id of ['read', 'unknown', 'interrupted', 'unanswered']) {
    put.run('tasks', id, JSON.stringify({ status: 'paused', summary, resumeReason: 'interrupted' }));
    put.run('operations', id, JSON.stringify({ taskId: id, readOnly: id !== 'unknown', status: 'succeeded',
      ...(id === 'interrupted' ? { interruption: { source: 'stop-button' } } : {}) }));
    if (id !== 'unanswered') put.run('messages', id, JSON.stringify({ taskId: id, role: 'agent', text: '查询完成', createdAt: 10 }));
  }
  legacy.close();
  const migrated = new SqliteStore(file);
  stores.push(migrated);
  for (const id of ['ready-for-review', 'accepted']) expect(migrated.get<{ status: string; report: { summary: string } }>('tasks', id))
    .toMatchObject({ status: 'answered', report: { summary: '已验证' } });
  expect(migrated.get<{ status: string; resumeReason?: string }>('tasks', 'legacy-unsafe'))
    .toMatchObject({ status: 'paused', resumeReason: 'verify' });
  expect(migrated.get('tasks', 'read')).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
  for (const id of ['unknown', 'interrupted', 'unanswered']) expect(migrated.get<{ status: string }>('tasks', id)?.status).toBe('paused');
  migrated.close(); stores.pop();
  const reopened = new SqliteStore(file);
  stores.push(reopened);
  expect(reopened.get('tasks', 'read')).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
});

it('adds migration 9 without declaring unexamined historical records repaired', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-repair-schema-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES(4,1),(5,1),(6,1),(7,1),(8,1);`);
  const original = { id: 'unknown', kind: 'command', status: 'unknown', preview: 'docker images' };
  legacy.prepare('INSERT INTO records VALUES(?,?,?,1)').run('operations', 'unknown', JSON.stringify(original));
  legacy.close();
  const store = new SqliteStore(file);
  stores.push(store);
  expect(store.get('operations', 'unknown')).toEqual(original);
  const inspection = new Database(file);
  try {
    expect(inspection.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 16 });
    expect(inspection.prepare('SELECT * FROM data_repairs').all()).toEqual([]);
  } finally { inspection.close(); }
});

it('commits repair receipts atomically and rejects changed or expanded read sets', () => {
  const store = open();
  store.put('operations', 'op', { readOnly: false });
  store.put('tasks', 'task', { pending: true });
  const repair = { name: 'fixture-query', version: 1, recordIds: ['op'],
    baselines: ['operations', 'tasks'].map((bucket) => ({ bucket, values: store.list(bucket) })),
    changes: [{ bucket: 'operations', id: 'op', value: { readOnly: true } },
      { bucket: 'tasks', id: 'task', value: { pending: false } }] };
  const put = store.put.bind(store);
  const fail = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
    if (bucket === 'tasks') throw new Error('disk failure');
    put(bucket, id, value);
  });
  expect(() => store.commitDataRepair(repair)).toThrow('disk failure');
  expect(store.get('operations', 'op')).toEqual({ readOnly: false });
  expect(store.get('tasks', 'task')).toEqual({ pending: true });
  fail.mockRestore();
  store.put('operations', 'foreign', { status: 'unknown' });
  expect(() => store.commitDataRepair(repair)).toThrow('source changed');
  store.remove('operations', 'foreign');
  store.commitDataRepair(repair); // The failed transaction did not consume its receipt.
  expect(store.get('operations', 'op')).toEqual({ readOnly: true });
  expect(store.get('tasks', 'task')).toEqual({ pending: false });
  expect(() => store.commitDataRepair({ ...repair,
    baselines: repair.baselines.map(({ bucket }) => ({ bucket, values: store.list(bucket) })),
    changes: [{ bucket: 'operations', id: 'op', value: { readOnly: false } }]
  })).toThrow(/UNIQUE/u);
  expect(store.get('operations', 'op')).toEqual({ readOnly: true });
});

it('upgrades a version-15 database in place with the delegation identity table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-delegation-upgrade-'));
  tempDirs.push(directory);
  const file = join(directory, 'records.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(bucket, id));
    INSERT INTO schema_migrations VALUES ${Array.from({ length: 15 }, (_, index) => `(${String(index + 1)},1)`).join(', ')};`);
  legacy.prepare('INSERT INTO records VALUES(?,?,?,1)').run('tasks', 'task', JSON.stringify({ id: 'task' }));
  legacy.close();
  const delegationId = '55555555-5555-4555-8555-555555555555';
  const store = new SqliteStore(file);
  stores.push(store);
  store.commitOperationRecord('op', { id: 'op', taskId: 'task' }, { delegationId, taskId: 'task' });
  expect(store.listOperationIdsByDelegation(delegationId)).toEqual(['op']);
  store.close(); stores.pop();
  const reopened = new SqliteStore(file);
  stores.push(reopened);
  expect(reopened.listOperationIdsByDelegation(delegationId)).toEqual(['op']);
});

it('commits an operation record and its delegation identity in one transaction', () => {
  const store = open();
  const view = { id: 'op-1', taskId: 'task', preview: 'systemctl restart nginx' };
  store.commitOperationRecord('op-1', view, { delegationId: '11111111-1111-4111-8111-111111111111', taskId: 'task', toolCallId: 'call_1' });
  expect(store.get('operations', 'op-1')).toEqual(view);
  expect(store.listOperationIdsByDelegation('11111111-1111-4111-8111-111111111111')).toEqual(['op-1']);
  // A second operation joins the same delegation unit; ordering follows commit time then id.
  store.commitOperationRecord('op-2', { id: 'op-2', taskId: 'task' }, { delegationId: '11111111-1111-4111-8111-111111111111', taskId: 'task' });
  expect(store.listOperationIdsByDelegation('11111111-1111-4111-8111-111111111111')).toEqual(['op-1', 'op-2']);
  // Re-committing an operation rebinds its delegation row instead of duplicating it.
  store.commitOperationRecord('op-1', { ...view, status: 'succeeded' }, { delegationId: '22222222-2222-4222-8222-222222222222', taskId: 'task' });
  expect(store.listOperationIdsByDelegation('11111111-1111-4111-8111-111111111111')).toEqual(['op-2']);
  expect(store.listOperationIdsByDelegation('22222222-2222-4222-8222-222222222222')).toEqual(['op-1']);
  // Records without a delegation identity commit alone and stay unlisted.
  store.commitOperationRecord('op-3', { id: 'op-3' }, undefined);
  expect(store.get('operations', 'op-3')).toEqual({ id: 'op-3' });
  expect(store.listOperationIdsByDelegation('33333333-3333-4333-8333-333333333333')).toEqual([]);
});

it('rolls back the delegation mapping together with the operation record on failure', () => {
  const store = open();
  const put = store.put.bind(store);
  const fail = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
    put(bucket, id, value);
    throw new Error('disk failure');
  });
  const delegationId = '44444444-4444-4444-8444-444444444444';
  expect(() => store.commitOperationRecord('op-x', { id: 'op-x' }, { delegationId, taskId: 'task' })).toThrow('disk failure');
  fail.mockRestore();
  expect(store.get('operations', 'op-x')).toBeUndefined();
  expect(store.listOperationIdsByDelegation(delegationId)).toEqual([]);
});

describe('record cleanup for deleted conversations', () => {
  it('removes records by JSON field and keeps other conversations', () => {
    const store = open();
    store.put('messages', 'm1', { taskId: 'a', text: 'hello' });
    store.put('messages', 'm2', { taskId: 'b', text: 'kept' });
    store.put('operations', 'o1', { taskId: 'a', preview: 'rm' });
    store.removeWhere('messages', 'taskId', 'a');
    expect(store.list('messages')).toEqual([{ taskId: 'b', text: 'kept' }]);
    expect(store.list('operations')).toHaveLength(1);
  });

  it('removes records by literal prefix without matching wildcard characters', () => {
    const store = open();
    store.put('model-requests', 'a:1', { taskId: 'a' });
    store.put('model-requests', 'a:2', { taskId: 'a' });
    store.put('model-requests', 'ab:1', { taskId: 'ab' });
    store.put('model-requests', 'a_1', { taskId: 'a' });
    store.removePrefix('model-requests', 'a:');
    expect(store.list('model-requests').map((item) => (item as { taskId: string }).taskId).sort()).toEqual(['a', 'ab']);
  });

  it('removes terminal logs of one session only', () => {
    const store = open();
    store.appendLog('t1', 'first');
    store.appendLog('t2', 'other');
    store.removeLogs('t1');
    expect(store.readLog('t1')).toBe('');
    expect(store.readLog('t2')).toBe('other');
  });

  it('rejects unsafe field names', () => {
    const store = open();
    expect(() => store.removeWhere('messages', "taskId') OR 1=1 --", 'a')).toThrow();
    expect(() => store.removeWhere('messages', 'task-id', 'a')).toThrow();
  });
});
