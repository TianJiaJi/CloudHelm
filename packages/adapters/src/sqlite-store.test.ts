import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.js';

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
