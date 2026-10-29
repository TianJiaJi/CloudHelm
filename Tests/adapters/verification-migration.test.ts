import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SqliteStore } from '../../packages/adapters/src/sqlite-store.js';

it('migration 11 archives legacy reports verbatim once without granting new verification status', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-verification-migration-'));
  const file = join(directory, 'records.sqlite');
  const handles: Array<{ close(): void }> = [];
  try {
    const initial = new SqliteStore(file); initial.close();
    const raw = new Database(file);
    raw.exec('DELETE FROM schema_migrations WHERE version = 11');
    const task = { id: 'legacy', provider: 'cloudhelm-custom', status: 'answered', report: { version: 2, summary: '旧报告', checks: [{ status: 'failed' }] },
      verificationState: { status: 'unverified', reasonCode: 'checks-failed' } };
    raw.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)').run('tasks', task.id, JSON.stringify(task)); raw.close();
    const migrated = new SqliteStore(file); handles.push(migrated);
    expect(migrated.get('tasks', task.id)).toEqual(task);
    expect(migrated.list('verification-reports')).toEqual([{ taskId: task.id, report: task.report }]);
    migrated.close();
    const reopened = new SqliteStore(file); handles.push(reopened);
    expect(reopened.list('verification-reports')).toHaveLength(1);
    expect(reopened.get('tasks', task.id)).toEqual(task); reopened.close();
  } finally {
    for (const handle of handles) { try { handle.close(); } catch { /* Already closed. */ } }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
