import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.js';

it('rolls back compatibility migrations 7–9 together and closes a failed database handle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-upgrade-rollback-'));
  const file = join(directory, 'records.sqlite');
  const summary = '已执行操作，但验证证据尚不完整。请继续核验后验收。';
  try {
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(bucket, id));
      INSERT INTO schema_migrations VALUES(4,1),(5,1),(6,1);
      CREATE TRIGGER fail_v9 BEFORE INSERT ON schema_migrations WHEN NEW.version = 9
        BEGIN SELECT RAISE(ABORT, 'simulated v9 disk failure'); END;`);
    const put = legacy.prepare('INSERT INTO records VALUES(?,?,?,1)');
    put.run('tasks', 'task', JSON.stringify({ id: 'task', status: 'paused', resumeReason: 'interrupted', summary }));
    put.run('operations', 'op', JSON.stringify({ id: 'op', taskId: 'task', readOnly: true, status: 'succeeded', exitCode: 0 }));
    put.run('messages', 'answer', JSON.stringify({ taskId: 'task', role: 'agent', text: '已完成', createdAt: 3 }));
    put.run('tasks', 'risk', JSON.stringify({ id: 'risk', status: 'accepted' }));
    put.run('operations', 'unknown', JSON.stringify({ id: 'unknown', taskId: 'risk', kind: 'command', status: 'unknown', preview: 'df -h' }));
    legacy.close();
    expect(() => new SqliteStore(file)).toThrow('simulated v9 disk failure');
    const inspection = new Database(file);
    try {
      expect(inspection.prepare('SELECT version FROM schema_migrations WHERE version >= 7').all()).toEqual([]);
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE name = 'data_repairs'").all()).toEqual([]);
      const row = inspection.prepare("SELECT value FROM records WHERE bucket = 'tasks' AND id = 'task'").get() as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
      inspection.exec('DROP TRIGGER fail_v9');
    } finally { inspection.close(); }
    const reopened = new SqliteStore(file);
    try {
      expect(reopened.get('tasks', 'task')).toMatchObject({ status: 'paused', resumeReason: 'interrupted', summary });
      expect(reopened.get<{ readOnly?: boolean }>('operations', 'unknown')?.readOnly).toBeUndefined();
      expect(reopened.get('tasks', 'risk')).toMatchObject({ status: 'paused', resumeReason: 'verify' });
    } finally { reopened.close(); }
    // On Windows this also verifies no failed-constructor handle retains the file.
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
