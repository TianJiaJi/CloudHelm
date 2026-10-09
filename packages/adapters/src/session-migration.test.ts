import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SqliteStore } from './sqlite-store.js';

it('cleans incompatible legacy projections once and preserves hosts, secrets, audit and unknown outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-upgrade-'));
  const file = join(root, 'database.sqlite');
  let store = new SqliteStore(file);
  try {
    for (const bucket of ['hosts', 'secrets', 'settings', 'shortcuts', 'operations']) {
      store.put(bucket, 'preserve', { taskId: 'old', status: 'unknown', protectedPaths: ['/srv/data'], evidence: 'keep' });
    }
    store.put('tasks', 'old', { id: 'old', goal: 'legacy task', status: 'running', modelId: 'old-model' });
    for (const bucket of ['messages', 'model-requests', 'clarifications']) store.put(bucket, 'old', { taskId: 'old', text: 'incompatible' });
    store.appendLog('operation:unknown', 'Evidence of an operation that may still be running.');
    store.close();
    const raw = new Database(file);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
    raw.close();
    store = new SqliteStore(file);
    for (const bucket of ['messages', 'model-requests', 'clarifications']) expect(store.list(bucket)).toEqual([]);
    expect(store.get('tasks', 'old')).toMatchObject({ id: 'old', goal: 'legacy task', status: 'paused' });
    expect(store.get<{ session?: unknown }>('tasks', 'old')?.session).toBeUndefined();
    for (const bucket of ['hosts', 'secrets', 'settings', 'shortcuts', 'operations']) expect(store.list(bucket)).toHaveLength(1);
    expect(store.readLog('operation:unknown')).toContain('may still be running');
    store.put('tasks', 'new', { id: 'new', session: { version: 1, id: 'new' }, status: 'paused' });
    store.put('messages', 'new:entry', { taskId: 'new', entryId: 'entry', text: 'native projection' });
    store.close();
    store = new SqliteStore(file);
    expect(store.list('messages')).toEqual([{ taskId: 'new', entryId: 'entry', text: 'native projection' }]);
    expect(store.get('tasks', 'new')).toMatchObject({ session: { id: 'new' } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
