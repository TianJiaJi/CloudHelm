import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) clean(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloudhelm-reference-recovery-')), file = join(root, 'fixture.sqlite');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const open = () => { const store = new SqliteStore(file); cleanups.push(() => store.close()); return store; };
  const raw = () => { const connection = new Database(file); cleanups.push(() => connection.close()); return connection; };
  return { open, raw };
}
const receipt = { state: 'dispatching' as const, fingerprint: 'synthetic' };
const body = (id: string) => ({ reference: { id, kind: 'paste' as const, capturedAt: 1 }, original: 'synthetic body' });

describe('guarded reference session recovery', () => {
  it('reclaims only prior guarded unbound copies and leaves legacy and bound ownership intact', () => {
    const f = fixture(), first = f.open();
    first.commitReferencePreparation('legacy', receipt, [body('legacy-copy')]);
    expect(first.beginReferenceSession('boot-one')).toBe(0);
    first.commitReferencePreparation('unbound', receipt, [body('unbound-copy')]);
    first.put('tasks', 'task', { id: 'task' });
    first.commitReferencePreparation('bound', { ...receipt, conversationId: 'task' }, [body('bound-copy')]);
    // A new startup is explicitly simulated; production requires the profile lock before this call.
    const second = f.open(); expect(second.beginReferenceSession('boot-two')).toBe(1);
    expect(second.readReference('unbound-copy')).toBeUndefined();
    expect(second.get('message-receipts', 'unbound')).toMatchObject({ state: 'failed' });
    expect(second.readReference('legacy-copy')).toBeDefined(); expect(second.readReference('bound-copy')).toBeDefined();
    expect(second.get('message-receipts', 'bound')).toMatchObject({ state: 'dispatching' });
    second.commitReferencePreparation('current', receipt, [body('current-copy')]);
    expect(() => second.beginReferenceSession('boot-three')).toThrow('already initialized');
    expect(second.readReference('current-copy')).toBeDefined();
  });

  it.each(['messages', 'conversation-inputs'])('preserves unknown preparations with durable %s evidence', (bucket) => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.commitReferencePreparation('request', receipt, [body('copy')]);
    first.put(bucket, 'published', { taskId: 'task', document: { requestId: 'request', parts: [{ type: 'reference', reference: body('copy').reference }] } });
    const second = f.open(); expect(second.beginReferenceSession('boot-two')).toBe(0);
    expect(second.readReference('copy')).toBeDefined(); expect(second.get('message-receipts', 'request')).toMatchObject({ state: 'dispatching' });
  });

  it('rolls recovery back on receipt persistence failure, allowing a fresh explicit startup retry', () => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.commitReferencePreparation('request', receipt, [body('copy')]);
    const second = f.open(), put = second.put.bind(second);
    vi.spyOn(second, 'put').mockImplementation((bucket, id, value) => { put(bucket, id, value); throw new Error('synthetic recovery failure'); });
    expect(() => second.beginReferenceSession('boot-two')).toThrow('synthetic recovery failure');
    expect(second.readReference('copy')).toBeDefined(); expect(second.get('message-receipts', 'request')).toMatchObject({ state: 'dispatching' });
    vi.restoreAllMocks(); expect(second.beginReferenceSession('boot-two')).toBe(1);
    expect(second.readReference('copy')).toBeUndefined();
  });

  it('does not resurrect removed receipts or discard a body shared by another durable document', () => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.commitReferencePreparation('request', receipt, [body('copy')]); first.remove('message-receipts', 'request');
    first.put('messages', 'other', { taskId: 'other', document: { requestId: 'different', parts: [{ type: 'reference', reference: body('copy').reference }] } });
    const second = f.open(); expect(second.beginReferenceSession('boot-two')).toBe(1);
    expect(second.get('message-receipts', 'request')).toBeUndefined(); expect(second.readReference('copy')).toBeDefined();
  });

  it('preserves already-accounted auxiliary usage while reclaiming abandoned copies', () => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.commitReferencePreparation('request', receipt, [body('copy')]);
    first.put('request-budget-scopes', 'aux:summary:request', { used: 1 });
    first.commitRequestBudget({ records: [], receipt: { owner: 'aux:summary:request', requestId: 'already-counted', binding: 'synthetic', value: { used: 1 } } });
    const second = f.open(); expect(second.beginReferenceSession('boot-two')).toBe(1);
    expect(second.get('request-budget-scopes', 'aux:summary:request')).toEqual({ used: 1 });
    expect(second.requestBudgetReceipt('aux:summary:request', 'already-counted')).toEqual({ binding: 'synthetic', value: { used: 1 } });
  });

  it.each(['sent', 'future-state'])('does not reinterpret conflicting receipt state %s as safe to reclaim', (state) => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.commitReferencePreparation('request', receipt, [body('copy')]);
    first.put('message-receipts', 'request', { ...receipt, state });
    const second = f.open(); expect(second.beginReferenceSession('boot-two')).toBe(0);
    expect(second.readReference('copy')).toBeDefined(); expect(second.get('message-receipts', 'request')).toMatchObject({ state });
  });

  it('recovers abandoned draft originals without claiming legacy bodies or deleting published evidence', () => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.createReferenceDraft('draft', 'renderer', { hostId: null });
    first.saveDraftReference('draft', 'renderer', body('original'));
    first.saveDraftReference('draft', 'renderer', body('published'));
    first.putReference('legacy-original', body('legacy-original'));
    first.claimDraftReferences('draft', 'renderer', ['legacy-original']);
    first.put('messages', 'message', { taskId: 'live', document: { parts: [{ type: 'reference', reference: body('published').reference }] } });
    const second = f.open(); second.beginReferenceSession('boot-two');
    expect(second.readReference('original')).toBeUndefined(); expect(second.readReference('published')).toBeDefined();
    expect(second.readReference('legacy-original')).toBeDefined();
    expect(() => second.assertReferenceDraft('draft', 'renderer')).toThrow('expired');
  });

  it('rolls back preparation and draft recovery together, then permits an explicit startup retry', () => {
    const f = fixture(), first = f.open(); first.beginReferenceSession('boot-one');
    first.createReferenceDraft('draft', 'renderer', { hostId: null }); first.saveDraftReference('draft', 'renderer', body('original'));
    first.commitReferencePreparation('request', receipt, [body('copy')]);
    const second = f.open(), remove = second.removeReference.bind(second);
    vi.spyOn(second, 'removeReference').mockImplementation((id) => { remove(id); if (id === 'original') throw new Error('synthetic draft cleanup failure'); });
    expect(() => second.beginReferenceSession('boot-two')).toThrow('synthetic draft cleanup failure');
    expect(second.readReference('original')).toBeDefined(); expect(second.readReference('copy')).toBeDefined();
    expect(second.get('message-receipts', 'request')).toMatchObject(receipt);
    first.assertDraftReference('draft', 'renderer', 'original');
    vi.restoreAllMocks(); expect(second.beginReferenceSession('boot-two')).toBe(1);
    expect(second.readReference('original')).toBeUndefined(); expect(second.readReference('copy')).toBeUndefined();
  });

  it('rolls back schema14 atomically without attributing preexisting reference bodies', () => {
    const f = fixture(), initial = f.open(); initial.putReference('legacy-original', body('legacy-original'));
    const raw = f.raw();
    raw.exec(`DROP TABLE reference_draft_holds; DROP TABLE reference_drafts; DROP TABLE reference_collection_candidates;
      DELETE FROM schema_migrations WHERE version=14;
      CREATE TRIGGER fail_v14 BEFORE INSERT ON schema_migrations WHEN NEW.version=14
      BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;`);
    expect(f.open).toThrow('synthetic migration failure');
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('reference_drafts','reference_draft_holds','reference_collection_candidates')").all()).toEqual([]);
    expect(raw.prepare('SELECT version FROM schema_migrations WHERE version=14').get()).toBeUndefined();
    raw.exec('DROP TRIGGER fail_v14'); const upgraded = f.open(); upgraded.beginReferenceSession('boot-new');
    expect(upgraded.readReference('legacy-original')).toBeDefined();
    expect(raw.prepare('SELECT * FROM reference_collection_candidates').all()).toEqual([]);
  });

  it('rolls back schema13 and never assigns guarded provenance to legacy records', () => {
    const f = fixture(), initial = f.open(); initial.commitReferencePreparation('legacy', receipt, [body('copy')]);
    const raw = f.raw();
    raw.exec(`ALTER TABLE reference_preparations DROP COLUMN producer_id;
      DELETE FROM schema_migrations WHERE version=13;
      CREATE TRIGGER fail_v13 BEFORE INSERT ON schema_migrations WHEN NEW.version=13
      BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;`);
    expect(f.open).toThrow('synthetic migration failure');
    expect((raw.prepare('PRAGMA table_info(reference_preparations)').all() as { name: string }[]).map((column) => column.name)).not.toContain('producer_id');
    expect(raw.prepare('SELECT version FROM schema_migrations WHERE version=13').get()).toBeUndefined();
    raw.exec('DROP TRIGGER fail_v13'); const upgraded = f.open();
    expect(upgraded.beginReferenceSession('boot-new')).toBe(0);
    expect(raw.prepare('SELECT producer_id FROM reference_preparations').get()).toEqual({ producer_id: null });
    expect(upgraded.readReference('copy')).toBeDefined();
  });
});
