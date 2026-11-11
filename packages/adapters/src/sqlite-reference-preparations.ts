import type Database from 'better-sqlite3';
import type { ReferenceBody } from '@cloudhelm/core';

export interface ReferencePreparationReceipt { fingerprint: string; state: 'dispatching'; conversationId?: string }
interface PreparationRow { conversation_id: string | null; reference_ids: string }
interface RecordReceipt { fingerprint: string; conversationId?: string; [key: string]: unknown }
interface Writes {
  body(id: string, value: ReferenceBody): void;
  receipt(id: string, value: unknown): void;
  remove(id: string): void;
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/u.test(id);
const documentReferences = `SELECT json_extract(part.value, '$.reference.id') AS id
  FROM records AS root, json_each(root.value, '$.document.parts') AS part
  WHERE root.bucket IN ('messages', 'conversation-inputs') AND json_extract(part.value, '$.type') = 'reference'`;
const ownedPreparations = `SELECT request_id, reference_ids FROM reference_preparations
  WHERE conversation_id = ? OR request_id IN (SELECT id FROM records
    WHERE bucket = 'message-receipts' AND json_extract(value, '$.conversationId') = ?)`;

/** Add ownership metadata without inferring or deleting legacy body provenance. */
export function migrateReferencePreparations(raw: Database.Database): void {
  raw.transaction(() => {
    if (raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 12').get()) return;
    raw.exec(`CREATE TABLE reference_preparations (
      request_id TEXT PRIMARY KEY, conversation_id TEXT, reference_ids TEXT NOT NULL
    );
    CREATE INDEX reference_preparations_owner ON reference_preparations(conversation_id);
    INSERT INTO schema_migrations(version, applied_at) VALUES (12, unixepoch());`);
  }).immediate();
  raw.transaction(() => {
    if (raw.prepare('SELECT 1 FROM schema_migrations WHERE version = 13').get()) return;
    // NULL means legacy/unproven provenance. Never backfill a guarded producer identity.
    raw.exec(`ALTER TABLE reference_preparations ADD COLUMN producer_id TEXT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (13, unixepoch());`);
  }).immediate();
}

/** Temporary send copies are retained by request until their conversation is deleted.
 * A failed/unknown runtime response is not proof that the message was never accepted. */
export class ReferencePreparations {
  private producerId?: string;
  constructor(private readonly raw: Database.Database, private readonly writes: Writes) {}
  private row(id: string): PreparationRow | undefined {
    return this.raw.prepare('SELECT conversation_id, reference_ids FROM reference_preparations WHERE request_id = ?').get(id) as PreparationRow | undefined;
  }
  private receipt(id: string): RecordReceipt | undefined {
    const row = this.raw.prepare("SELECT value FROM records WHERE bucket = 'message-receipts' AND id = ?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as RecordReceipt : undefined;
  }
  private assertTask(id: string): void {
    if (!this.raw.prepare("SELECT 1 FROM records WHERE bucket = 'tasks' AND id = ?").get(id)) throw new Error('Reference preparation owner unavailable');
  }
  /** Startup only, before IPC/Worker admission and under exclusive profile ownership.
   * Guarded producers cannot dispatch a new conversation before binding this row. */
  beginSession(producerId: string): number {
    if (this.producerId) throw new Error('Reference session already initialized');
    if (!validId(producerId)) throw new Error('Invalid reference session');
    const reclaimed = this.raw.transaction(() => {
      const rows = this.raw.prepare(`SELECT request_id, reference_ids FROM reference_preparations
        WHERE conversation_id IS NULL AND producer_id IS NOT NULL AND producer_id != ?`)
        .all(producerId) as { request_id: string; reference_ids: string }[];
      let count = 0;
      for (const row of rows) {
        const receipt = this.receipt(row.request_id);
        if (receipt && receipt.state !== 'preparing' && receipt.state !== 'dispatching' && receipt.state !== 'failed') continue;
        const published = this.raw.prepare(`SELECT 1 FROM records WHERE bucket IN ('messages', 'conversation-inputs')
          AND json_extract(value, '$.document.requestId') = ? LIMIT 1`).get(row.request_id);
        if (published) continue; // Conflicting delivery evidence stays conservative; never enable replay.
        this.raw.prepare('DELETE FROM reference_preparations WHERE request_id = ?').run(row.request_id);
        this.collect(JSON.parse(row.reference_ids) as string[]);
        if (receipt) this.writes.receipt(row.request_id, { ...receipt, state: 'failed' });
        count++;
      }
      return count;
    }).immediate();
    this.producerId = producerId; // Only after the recovery transaction commits.
    return reclaimed;
  }
  commit(id: string, receipt: ReferencePreparationReceipt, bodies: ReferenceBody[]): void {
    if (!validId(id) || receipt.state !== 'dispatching' || typeof receipt.fingerprint !== 'string' || !Array.isArray(bodies)
      || bodies.length > 1000 || bodies.some((body) => !validId(body?.reference?.id) || typeof body.original !== 'string')
      || new Set(bodies.map((body) => body.reference.id)).size !== bodies.length) throw new Error('Invalid reference preparation');
    this.raw.transaction(() => {
      const prior = this.row(id), previousReceipt = this.receipt(id);
      if (receipt.conversationId !== undefined) this.assertTask(receipt.conversationId);
      if (prior && prior.conversation_id !== (receipt.conversationId ?? null)
        || previousReceipt && previousReceipt.fingerprint !== receipt.fingerprint) throw new Error('Reference preparation owner changed');
      const ids = new Set<string>(prior ? JSON.parse(prior.reference_ids) as string[] : []);
      for (const body of bodies) {
        if (this.raw.prepare('SELECT 1 FROM content_references WHERE id = ?').get(body.reference.id)) throw new Error('Reference body already exists');
        this.writes.body(body.reference.id, body); ids.add(body.reference.id);
      }
      this.raw.prepare(`INSERT INTO reference_preparations(request_id, conversation_id, reference_ids, producer_id) VALUES(?,?,?,?)
        ON CONFLICT(request_id) DO UPDATE SET reference_ids=excluded.reference_ids`)
        .run(id, receipt.conversationId ?? null, JSON.stringify([...ids]), this.producerId ?? null);
      this.writes.receipt(id, receipt);
    }).immediate();
  }
  bind(id: string, taskId: string): void {
    this.raw.transaction(() => {
      this.assertTask(taskId);
      const row = this.row(id), receipt = this.receipt(id);
      if (!row || !receipt) throw new Error('Reference preparation unavailable');
      if (row.conversation_id && row.conversation_id !== taskId || receipt.conversationId && receipt.conversationId !== taskId)
        throw new Error('Reference preparation owner changed');
      this.raw.prepare('UPDATE reference_preparations SET conversation_id = ? WHERE request_id = ?').run(taskId, id);
      this.writes.receipt(id, { ...receipt, conversationId: taskId });
    }).immediate();
  }
  /** Only the caller that knows task creation never occurred may abandon this hold. */
  discardUnbound(id: string): void {
    this.raw.transaction(() => {
      const row = this.row(id);
      if (!row) return;
      if (row.conversation_id || this.receipt(id)?.conversationId) throw new Error('Reference preparation is bound');
      this.raw.prepare('DELETE FROM reference_preparations WHERE request_id = ?').run(id);
      this.collect(JSON.parse(row.reference_ids) as string[]);
    }).immediate();
  }
  /** Must run inside the same transaction that deletes the owner's records. */
  detachConversation(taskId: string): string[] {
    const documents = this.raw.prepare(`${documentReferences} AND json_extract(root.value, '$.taskId') = ?`).all(taskId) as { id: string }[];
    const preparations = this.raw.prepare(ownedPreparations).all(taskId, taskId) as { request_id: string; reference_ids: string }[];
    const ids = new Set(documents.map((row) => row.id));
    for (const row of preparations) {
      for (const id of JSON.parse(row.reference_ids) as string[]) ids.add(id);
      this.raw.prepare('DELETE FROM reference_preparations WHERE request_id = ?').run(row.request_id);
    }
    return [...ids];
  }
  collect(ids: Iterable<string>): void {
    for (const id of new Set(ids)) {
      const document = this.raw.prepare(`${documentReferences} AND json_extract(part.value, '$.reference.id') = ? LIMIT 1`).get(id);
      const held = this.raw.prepare(`SELECT 1 FROM reference_preparations, json_each(reference_ids) AS item WHERE item.value = ? LIMIT 1`).get(id);
      if (!document && !held) this.writes.remove(id);
    }
  }
}
