import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceBody } from '@cloudhelm/core';

const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
function disk() {
  const root = mkdtempSync(join(tmpdir(), 'cloudhelm-reference-ownership-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'synthetic.sqlite');
}
const body: ReferenceBody = { reference: { id: 'copy', kind: 'paste', capturedAt: 1 }, original: 'synthetic body' };
const receipt = { fingerprint: 'synthetic', state: 'dispatching' as const };

describe('E02: durable reference preparation records', () => {
  it('migrates the new ownership table and version together without changing existing bodies', () => {
    const file = disk(); const initial = new SqliteStore(file);
    initial.putReference('legacy', { ...body, reference: { ...body.reference, id: 'legacy' } }); initial.close();
    const raw = new Database(file); resources.push(() => raw.close());
    raw.exec(`DROP TABLE reference_draft_holds; DROP TABLE reference_drafts; DROP TABLE reference_collection_candidates;
      DROP TABLE reference_preparations; DELETE FROM schema_migrations WHERE version >= 12;
      CREATE TRIGGER fail_v12 BEFORE INSERT ON schema_migrations WHEN NEW.version = 12
      BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;`);
    expect(() => new SqliteStore(file)).toThrow('synthetic migration failure');
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='reference_preparations'").get()).toBeUndefined();
    expect(raw.prepare('SELECT version FROM schema_migrations WHERE version=12').get()).toBeUndefined();
    expect(raw.prepare("SELECT id FROM content_references WHERE id='legacy'").get()).toBeDefined();
    raw.exec('DROP TRIGGER fail_v12');
    const repaired = new SqliteStore(file); resources.push(() => repaired.close());
    expect(raw.prepare('SELECT version FROM schema_migrations WHERE version=12').get()).toEqual({ version: 12 });
    expect(repaired.readReference('legacy')).toBeDefined();
  });

  it('binds new-conversation copies before runtime dispatch and preserves ownership across restart', () => {
    const file = disk(); const first = new SqliteStore(file);
    first.commitReferencePreparation('request', receipt, [body]);
    first.put('tasks', 'task', { id: 'task' });
    first.bindReferencePreparation('request', 'task'); first.close();
    const restarted = new SqliteStore(file); resources.push(() => restarted.close());
    expect(restarted.get('message-receipts', 'request')).toMatchObject({ conversationId: 'task', state: 'dispatching' });
    expect(() => restarted.discardUnboundReferencePreparation('request')).toThrow('bound');
    restarted.put('tasks', 'foreign', { id: 'foreign' });
    expect(() => restarted.bindReferencePreparation('request', 'foreign')).toThrow('owner');
    restarted.commitConversationDeletion('task', [], []);
    expect(restarted.readReference('copy')).toBeUndefined();
  });

  it('does not overwrite existing bodies and atomically rejects duplicate preparation ids', () => {
    const store = new SqliteStore(':memory:'); resources.push(() => store.close());
    store.putReference('copy', body);
    expect(() => store.commitReferencePreparation('request', receipt, [body])).toThrow('already exists');
    expect(store.readReference('copy')).toEqual(body);
    expect(store.get('message-receipts', 'request')).toBeUndefined();
    const another = { ...body, reference: { ...body.reference, id: 'another' } };
    expect(() => store.commitReferencePreparation('request', receipt, [another, another])).toThrow('Invalid');
    expect(store.readReference('another')).toBeUndefined();
  });

  it('cannot promote or change an unbound owner by writing another batch; explicit bind is required', () => {
    const store = new SqliteStore(':memory:'); resources.push(() => store.close());
    store.put('tasks', 'task', { id: 'task' });
    store.commitReferencePreparation('request', receipt, [body]);
    const another = { ...body, reference: { ...body.reference, id: 'another' } };
    expect(() => store.commitReferencePreparation('request', { ...receipt, conversationId: 'task' }, [another])).toThrow('owner changed');
    expect(store.readReference('another')).toBeUndefined();
    expect(store.get('message-receipts', 'request')).not.toHaveProperty('conversationId');
    store.bindReferencePreparation('request', 'task');
    store.commitReferencePreparation('request', { ...receipt, conversationId: 'task' }, [another]);
    store.commitConversationDeletion('task', [], []);
    expect(store.readReference('copy')).toBeUndefined(); expect(store.readReference('another')).toBeUndefined();
  });

  it('reclaims only unbound preparation copies, never a body already referenced by durable input', () => {
    const store = new SqliteStore(':memory:'); resources.push(() => store.close());
    store.commitReferencePreparation('request', receipt, [body]);
    store.put('conversation-inputs', 'input', { taskId: 'other', document: { parts: [{ type: 'reference', reference: body.reference }] } });
    store.discardUnboundReferencePreparation('request');
    expect(store.readReference('copy')).toEqual(body);
    store.put('tasks', 'other', { id: 'other' }); store.commitConversationDeletion('other', [], []);
    expect(store.readReference('copy')).toBeUndefined();
  });
});
