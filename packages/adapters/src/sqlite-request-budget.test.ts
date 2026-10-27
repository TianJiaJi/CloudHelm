import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { SqliteStore, type RequestBudgetCommit } from './sqlite-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudhelm-budget-store-')); const file = join(dir, 'state.db');
  const store = new SqliteStore(file); const raw = new Database(file);
  cleanups.push(() => { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, raw, file };
}
it('migrates only schema version 10 atomically and permits recovery after a failed constructor', () => {
  const f = fixture();
  f.store.put('tasks', 'task', { id: 'task', provider: 'fixture-provider', requestCount: 17 });
  f.raw.exec(`DROP TABLE request_budget_receipts; DELETE FROM schema_migrations WHERE version = 10;
    CREATE TRIGGER fail_v10 BEFORE INSERT ON schema_migrations WHEN NEW.version = 10
    BEGIN SELECT RAISE(ABORT, 'simulated v10 failure'); END`);
  expect(() => new SqliteStore(f.file)).toThrow('simulated v10 failure');
  expect(f.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
    Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })));
  expect(f.raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'request_budget_receipts'").get()).toBeUndefined();
  expect(f.store.get('tasks', 'task')).toEqual({ id: 'task', provider: 'fixture-provider', requestCount: 17 });
  f.raw.exec('DROP TRIGGER fail_v10');
  const upgraded = new SqliteStore(f.file); cleanups.push(() => upgraded.close());
  expect(f.raw.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 10 });
});
it('rolls back record writes if the attempt receipt insert fails, then commits exactly once', () => {
  const f = fixture(); const before = { id: 'task', requestCount: 0 }; const after = { ...before, requestCount: 1 };
  f.store.put('tasks', 'task', before);
  const change: RequestBudgetCommit = { records: [{ bucket: 'tasks', id: 'task', before, value: after }],
    receipt: { owner: 'task:task', requestId: 'attempt:one/1', binding: 'fixed-binding', value: { phase: 'reserved' } } };
  f.raw.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON request_budget_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated receipt write failure'); END`);
  expect(() => f.store.commitRequestBudget(change)).toThrow('simulated receipt write failure');
  expect(f.store.get('tasks', 'task')).toEqual(before);
  expect(f.store.requestBudgetReceipt('task:task', 'attempt:one/1')).toBeUndefined();
  f.raw.exec('DROP TRIGGER fail_receipt');
  f.store.commitRequestBudget(change);
  expect(f.store.get('tasks', 'task')).toEqual(after);
  expect(() => f.store.commitRequestBudget(change)).toThrow('Budget receipt changed');
  expect(f.store.get('tasks', 'task')).toEqual(after);
});
it('compare-and-sets continuation claims and preserves granted state when updating a receipt fails', () => {
  const f = fixture(); const receipt = { owner: 'task:task', requestId: 'extension:one', binding: 'round/revision', value: { phase: 'granted' } };
  f.store.commitRequestBudget({ records: [], receipt });
  const claim = { ...receipt, before: receipt.value, value: { phase: 'dispatching' } };
  f.raw.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON request_budget_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated claim failure'); END`);
  expect(() => f.store.commitRequestBudget({ records: [], receipt: claim })).toThrow('simulated claim failure');
  expect(f.store.requestBudgetReceipt(receipt.owner, receipt.requestId)?.value).toEqual({ phase: 'granted' });
  f.raw.exec('DROP TRIGGER fail_claim');
  f.store.commitRequestBudget({ records: [], receipt: claim });
  expect(() => f.store.commitRequestBudget({ records: [], receipt: claim })).toThrow('Budget receipt changed');
  expect(() => f.store.commitRequestBudget({ records: [], receipt: { ...claim, before: claim.value, binding: 'other' } })).toThrow('Budget receipt changed');
  expect(f.store.requestBudgetReceipt(receipt.owner, receipt.requestId)?.value).toEqual({ phase: 'dispatching' });
});
