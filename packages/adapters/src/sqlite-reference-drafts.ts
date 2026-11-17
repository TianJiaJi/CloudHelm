import type Database from 'better-sqlite3';
import type { ReferenceBody } from '@cloudhelm/core';

export interface ReferenceDraftScope { conversationId?: string; hostId: string | null }
interface DraftRow { id: string; producer_id: string; recipient_id: string; conversation_id: string | null; host_id: string | null }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/u.test(id);
const scopeOf = (row: DraftRow): ReferenceDraftScope => ({ ...(row.conversation_id ? { conversationId: row.conversation_id } : {}), hostId: row.host_id });

/** Latest schema version this module writes; SqliteStore aggregates it into the downgrade guard. */
export const REFERENCE_DRAFTS_SCHEMA_VERSION = 14;

export function migrateReferenceDrafts(raw: Database.Database): void {
  raw.transaction(() => {
    if (raw.prepare('SELECT 1 FROM schema_migrations WHERE version=14').get()) return;
    raw.exec(`CREATE TABLE reference_drafts (
      id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, recipient_id TEXT NOT NULL, conversation_id TEXT, host_id TEXT
    );
    CREATE INDEX reference_drafts_conversation ON reference_drafts(conversation_id);
    CREATE TABLE reference_draft_holds (draft_id TEXT NOT NULL, reference_id TEXT NOT NULL, PRIMARY KEY(draft_id, reference_id));
    CREATE INDEX reference_draft_holds_reference ON reference_draft_holds(reference_id);
    CREATE TABLE reference_collection_candidates (reference_id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES(14, unixepoch());`);
  }).immediate();
}

/** A lease retains the draft's quoted/claimed bodies, including undo history, until explicit release. */
export class ReferenceDrafts {
  constructor(private readonly raw: Database.Database, private readonly putBody: (id: string, value: ReferenceBody) => void,
    private readonly collect: (ids: Iterable<string>) => void) {}
  private target(scope: ReferenceDraftScope): void {
    if (scope.hostId !== null && (typeof scope.hostId !== 'string' || !scope.hostId
      || !this.raw.prepare("SELECT 1 FROM records WHERE bucket='hosts' AND id=?").get(scope.hostId))) throw new Error('Reference draft host unavailable');
    if (scope.conversationId !== undefined) {
      if (!validId(scope.conversationId)) throw new Error('Invalid reference draft target');
      const task = this.raw.prepare("SELECT value FROM records WHERE bucket='tasks' AND id=?").get(scope.conversationId) as { value: string } | undefined;
      if (!task) throw new Error('Reference draft conversation unavailable');
      const hostIds = (JSON.parse(task.value) as { hostIds?: unknown }).hostIds;
      if (!Array.isArray(hostIds) || hostIds.length > 1 || (hostIds[0] ?? null) !== scope.hostId) throw new Error('Reference draft target changed');
    }
  }
  create(id: string, producer: string, recipient: string, scope: ReferenceDraftScope): void {
    if (!validId(id) || !validId(producer) || !validId(recipient)) throw new Error('Invalid reference draft identity');
    this.raw.transaction(() => {
      this.target(scope);
      this.raw.prepare('INSERT INTO reference_drafts(id,producer_id,recipient_id,conversation_id,host_id) VALUES(?,?,?,?,?)')
        .run(id, producer, recipient, scope.conversationId ?? null, scope.hostId);
    }).immediate();
  }
  private owned(id: string, producer: string, recipient: string): DraftRow {
    if (!validId(id) || !validId(producer) || !validId(recipient)) throw new Error('Invalid reference draft identity');
    const row = this.raw.prepare('SELECT * FROM reference_drafts WHERE id=? AND producer_id=? AND recipient_id=?').get(id, producer, recipient) as DraftRow | undefined;
    if (!row) throw new Error('Reference draft expired; add the reference again');
    return row;
  }
  assert(id: string, producer: string, recipient: string, scope?: ReferenceDraftScope): ReferenceDraftScope {
    const row = this.owned(id, producer, recipient), current = scopeOf(row);
    if (scope && (scope.conversationId !== current.conversationId || scope.hostId !== current.hostId)) throw new Error('Reference draft target mismatch');
    this.target(current);
    return current;
  }
  private accepts(row: DraftRow, kind: unknown, hostId: unknown): void {
    if (kind !== 'paste' && kind !== 'terminal') throw new Error('Invalid reference kind');
    if (kind === 'terminal' && (typeof hostId !== 'string' || !hostId || hostId !== row.host_id)) throw new Error('Reference host does not match draft');
  }
  private capacity(id: string, extra: string[]): void {
    const held = this.raw.prepare('SELECT reference_id FROM reference_draft_holds WHERE draft_id=?').all(id) as { reference_id: string }[];
    if (new Set([...held.map((row) => row.reference_id), ...extra]).size > 1000) throw new Error('Reference draft capacity exceeded; discard the draft to release its history');
  }
  save(id: string, producer: string, recipient: string, body: ReferenceBody): void {
    if (!validId(body?.reference?.id) || typeof body.original !== 'string') throw new Error('Invalid reference body');
    this.raw.transaction(() => {
      const row = this.owned(id, producer, recipient); this.target(scopeOf(row)); this.accepts(row, body.reference.kind, body.reference.hostId);
      this.capacity(id, [body.reference.id]);
      if (this.raw.prepare('SELECT 1 FROM content_references WHERE id=?').get(body.reference.id)) throw new Error('Reference body already exists');
      this.putBody(body.reference.id, body);
      this.raw.prepare('INSERT INTO reference_collection_candidates(reference_id) VALUES(?)').run(body.reference.id);
      this.raw.prepare('INSERT INTO reference_draft_holds(draft_id,reference_id) VALUES(?,?)').run(id, body.reference.id);
    }).immediate();
  }
  claim(id: string, producer: string, recipient: string, ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some((key) => !validId(key))) throw new Error('Invalid draft reference list');
    this.raw.transaction(() => {
      const row = this.owned(id, producer, recipient); this.target(scopeOf(row)); this.capacity(id, ids);
      for (const key of new Set(ids)) {
        const body = this.raw.prepare(`SELECT json_extract(value,'$.reference.kind') AS kind, json_extract(value,'$.reference.hostId') AS host
          FROM content_references WHERE id=?`).get(key) as { kind: unknown; host: unknown } | undefined;
        if (!body) throw new Error('Reference expired; add the reference again');
        this.accepts(row, body.kind, body.host);
        this.raw.prepare('INSERT OR IGNORE INTO reference_draft_holds(draft_id,reference_id) VALUES(?,?)').run(id, key);
      }
    }).immediate();
  }
  contains(id: string, producer: string, recipient: string, referenceId: string): void {
    this.assert(id, producer, recipient);
    if (!this.raw.prepare('SELECT 1 FROM reference_draft_holds WHERE draft_id=? AND reference_id=?').get(id, referenceId)) throw new Error('Reference is not held by this draft');
  }
  private detach(ids: string[]): string[] {
    const references = new Set<string>();
    for (const id of ids) {
      const held = this.raw.prepare('SELECT reference_id FROM reference_draft_holds WHERE draft_id=?').all(id) as { reference_id: string }[];
      for (const row of held) references.add(row.reference_id);
      this.raw.prepare('DELETE FROM reference_draft_holds WHERE draft_id=?').run(id);
      this.raw.prepare('DELETE FROM reference_drafts WHERE id=?').run(id);
    }
    return [...references];
  }
  release(id: string, producer: string, recipient: string): void {
    this.raw.transaction(() => {
      const exists = this.raw.prepare('SELECT 1 FROM reference_drafts WHERE id=?').get(id);
      if (!exists) return; // A completed release/deletion is idempotent; never recreate a lease.
      this.owned(id, producer, recipient);
      this.collect(this.detach([id]));
    }).immediate();
  }
  releaseRecipient(producer: string, recipient: string): void {
    this.raw.transaction(() => {
      const rows = this.raw.prepare('SELECT id FROM reference_drafts WHERE producer_id=? AND recipient_id=?').all(producer, recipient) as { id: string }[];
      this.collect(this.detach(rows.map((row) => row.id)));
    }).immediate();
  }
  /** Caller owns the conversation-deletion transaction; collect only after deleting its records. */
  detachConversation(taskId: string): string[] {
    const rows = this.raw.prepare('SELECT id FROM reference_drafts WHERE conversation_id=?').all(taskId) as { id: string }[];
    return this.detach(rows.map((row) => row.id));
  }
  /** Caller holds exclusive profile ownership and the startup recovery transaction. */
  recover(producer: string): void {
    const rows = this.raw.prepare('SELECT id FROM reference_drafts WHERE producer_id != ?').all(producer) as { id: string }[];
    this.collect(this.detach(rows.map((row) => row.id)));
  }
}
