import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const records = sqliteTable('records', {
  bucket: text('bucket').notNull(),
  id: text('id').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [primaryKey({ columns: [table.bucket, table.id] })]);

/** Versioned migration 0001: durable application records. Secret values are encrypted before insertion. */
const migration0001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, id)
);
CREATE INDEX IF NOT EXISTS records_updated_at ON records(bucket, updated_at);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());
`;
const migration0002 = `
CREATE TABLE IF NOT EXISTS terminal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_logs_lookup ON terminal_logs(terminal_id, id);
CREATE INDEX IF NOT EXISTS terminal_logs_retention ON terminal_logs(created_at);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
`;

const migration0003 = `
UPDATE records SET value = json_set(value, '$.provider',
  coalesce((SELECT json_extract(value, '$.provider') FROM records WHERE bucket = 'settings' AND id = 'model-profile'), 'vercel-ai-gateway'))
WHERE bucket = 'tasks' AND json_extract(value, '$.provider') IS NULL;
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
`;

export class SqliteStore {
  private readonly raw: Database.Database;
  private readonly db;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.exec(migration0001);
    this.raw.exec(migration0002);
    this.raw.exec(migration0003);
    // Run destructive compatibility cleanup exactly once, atomically with its version marker.
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 4').get()) return;
      this.raw.exec(`
        DELETE FROM records WHERE bucket IN ('messages', 'model-requests', 'clarifications');
        UPDATE records SET value = json_remove(json_set(value, '$.status',
          CASE WHEN json_extract(value, '$.status') IN ('accepted', 'ready-for-review')
          THEN json_extract(value, '$.status') ELSE 'paused' END), '$.session') WHERE bucket = 'tasks';
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());
      `);
    })();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 5').get()) return;
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS content_references (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_migrations(version, applied_at) VALUES (5, unixepoch());
      `);
    })();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 6').get()) return;
      this.raw.exec(`
        UPDATE records SET value = json_set(value,
          '$.protectedReadPaths', json(coalesce(json_extract(value, '$.protectedReadPaths'), json_extract(value, '$.protectedPaths'), '[]')),
          '$.protectedWritePaths', json(coalesce(json_extract(value, '$.protectedWritePaths'), json_extract(value, '$.protectedPaths'), '[]')))
        WHERE bucket = 'hosts';
        UPDATE records SET value = json_set(value,
          '$.reviewModesByHost', json(coalesce(json_extract(value, '$.reviewModesByHost'),
            (SELECT json_group_object(ids.value, coalesce(json_extract(host.value, '$.defaultMode'), 'ask'))
             FROM json_each(records.value, '$.hostIds') AS ids
             LEFT JOIN records AS host ON host.bucket = 'hosts' AND host.id = ids.value), '{}')),
          '$.reviewRevision', coalesce(json_extract(value, '$.reviewRevision'), 1))
        WHERE bucket = 'tasks';
        INSERT INTO schema_migrations(version, applied_at) VALUES (6, unixepoch());
      `);
    })();
    this.raw.transaction(() => {
      if (this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 7').get()) return;
      // Legacy records did not persist the read-only capability. Only exact,
      // trivially safe historical previews can be recovered without the source command.
      this.raw.exec(`
        UPDATE records SET value = json_set(value, '$.readOnly', json('true'))
        WHERE bucket = 'operations' AND json_extract(value, '$.kind') = 'command'
          AND json_extract(value, '$.status') = 'unknown'
          AND json_extract(value, '$.readOnly') IS NULL
          AND json_extract(value, '$.preview') IN ('df -h', 'df -hT', 'docker ps', 'docker ps -a');
        INSERT INTO schema_migrations(version, applied_at) VALUES (7, unixepoch());
      `);
    })();
    this.db = drizzle(this.raw);
  }

  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.select({ value: records.value }).from(records)
      .where(and(eq(records.bucket, bucket), eq(records.id, id))).get();
    return row ? JSON.parse(row.value) as T : undefined;
  }

  list<T>(bucket: string): T[] {
    return this.db.select({ value: records.value }).from(records).where(eq(records.bucket, bucket)).all()
      .map((row) => JSON.parse(row.value) as T);
  }

  put(bucket: string, id: string, value: unknown): void {
    this.db.insert(records).values({ bucket, id, value: JSON.stringify(value), updatedAt: Date.now() })
      .onConflictDoUpdate({ target: [records.bucket, records.id], set: { value: JSON.stringify(value), updatedAt: Date.now() } }).run();
  }

  remove(bucket: string, id: string): void {
    this.db.delete(records).where(and(eq(records.bucket, bucket), eq(records.id, id))).run();
  }

  /** Removes records whose JSON field matches a value (conversation cleanup). */
  removeWhere(bucket: string, field: string, value: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(field)) throw new Error('Invalid record field');
    this.raw.prepare(`DELETE FROM records WHERE bucket = ? AND json_extract(value, '$.${field}') = ?`).run(bucket, value);
  }

  /** Removes records whose id starts with a literal prefix. */
  removePrefix(bucket: string, idPrefix: string): void {
    const escaped = idPrefix.replace(/[\\%_]/gu, (char) => `\\${char}`);
    this.raw.prepare("DELETE FROM records WHERE bucket = ? AND id LIKE ? ESCAPE '\\'").run(bucket, `${escaped}%`);
  }

  removeLogs(terminalId: string): void {
    this.raw.prepare('DELETE FROM terminal_logs WHERE terminal_id = ?').run(terminalId);
  }

  appendLog(terminalId: string, data: string): void {
    const insert = this.raw.prepare('INSERT INTO terminal_logs(terminal_id, created_at, bytes, data) VALUES (?, ?, ?, ?)');
    for (let offset = 0; offset < data.length; offset += 8192) {
      const chunk = data.slice(offset, offset + 8192);
      insert.run(terminalId, Date.now(), Buffer.byteLength(chunk), chunk);
    }
  }

  putReference(id: string, value: unknown): void {
    this.raw.prepare('INSERT OR REPLACE INTO content_references(id, value) VALUES (?, ?)').run(id, JSON.stringify(value));
  }
  readReference<T>(id: string): T | undefined {
    const row = this.raw.prepare('SELECT value FROM content_references WHERE id = ?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  removeReference(id: string): void { this.raw.prepare('DELETE FROM content_references WHERE id = ?').run(id); }
  readCompleteLog(id: string, expectedLength: number): string {
    const rows = this.raw.prepare('SELECT data FROM terminal_logs WHERE terminal_id = ? ORDER BY id').all(id) as { data: string }[];
    const value = rows.map((row) => row.data).join('');
    if (value.length !== expectedLength) throw new Error('命令日志已不完整，请手动选择引用内容');
    return value;
  }

  readLog(terminalId: string, maxBytes = 1_000_000): string {
    const rows = this.raw.prepare('SELECT data, bytes FROM terminal_logs WHERE terminal_id = ? ORDER BY id DESC LIMIT 1000')
      .all(terminalId) as Array<{ data: string; bytes: number }>;
    let size = 0;
    const selected: string[] = [];
    for (const row of rows) {
      if (size >= maxBytes) break;
      selected.push(row.data);
      size += row.bytes;
    }
    return selected.reverse().join('').slice(-maxBytes);
  }

  readLogPage(terminalId: string, cursor = 0): { text: string; nextCursor: number; more: boolean } {
    const rows = this.raw.prepare('SELECT id, data FROM terminal_logs WHERE terminal_id = ? AND id > ? ORDER BY id LIMIT 5')
      .all(terminalId, cursor) as Array<{ id: number; data: string }>;
    const page = rows.slice(0, 4);
    return { text: page.map((row) => row.data).join(''), nextCursor: page.at(-1)?.id ?? cursor, more: rows.length > 4 };
  }

  cleanupLogs(maxAgeMs = 30 * 24 * 60 * 60_000, maxBytes = 5 * 1024 ** 3): void {
    this.raw.prepare('DELETE FROM terminal_logs WHERE created_at < ?').run(Date.now() - maxAgeMs);
    let size = (this.raw.prepare('SELECT coalesce(sum(bytes), 0) AS size FROM terminal_logs').get() as { size: number }).size;
    const drop = this.raw.prepare('DELETE FROM terminal_logs WHERE id IN (SELECT id FROM terminal_logs ORDER BY id LIMIT 1000)');
    while (size > maxBytes) {
      const changed = drop.run().changes;
      if (!changed) break;
      size = (this.raw.prepare('SELECT coalesce(sum(bytes), 0) AS size FROM terminal_logs').get() as { size: number }).size;
    }
  }

  close(): void { this.raw.close(); }
}
