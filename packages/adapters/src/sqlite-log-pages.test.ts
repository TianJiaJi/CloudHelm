import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from './sqlite-store.js';

it('keeps UTF-16 pairs intact across storage chunks and returns whole bounded pages with no omissions', () => {
  const store = new SqliteStore(':memory:');
  const original = `${'中'.repeat(8191)}${'🙂'.repeat(20000)}\n`;
  try {
    store.appendLog('own', original);
    store.appendLog('foreign', 'must not appear');
    let cursor = 0;
    let text = '';
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = store.readLogPage('own', cursor);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(48 * 1024);
      expect(page.nextCursor).toBeGreaterThan(cursor);
      text += page.text; cursor = page.nextCursor;
      if (!page.more) break;
    }
    expect(text).toBe(original);
    expect(text).not.toContain('\ufffd');
    expect(store.readLogPage('own', cursor)).toEqual({ text: '', nextCursor: cursor, more: false });
    expect(store.readLogPage('missing')).toEqual({ text: '', nextCursor: 0, more: false });
    for (const invalid of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => store.readLogPage('own', invalid)).toThrow('cursor');
  } finally { store.close(); }
});
it('preserves NUL suffixes and leading BOM characters through bounded retrieval', () => {
  const store = new SqliteStore(':memory:');
  const original = '\ufeffbefore\u0000after🙂\n'.repeat(1000);
  try {
    store.appendLog('nul', original);
    const page = store.readLogPage('nul');
    expect(page.text).toBe(original);
    expect(page.more).toBe(false);
  } finally { store.close(); }
});
it('rejects oversized or invalid-UTF8 legacy chunks without silently consuming them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudhelm-log-bound-'));
  const path = join(directory, 'fixture.sqlite');
  const store = new SqliteStore(path);
  const raw = new Database(path);
  try {
    raw.prepare('INSERT INTO terminal_logs(terminal_id,created_at,bytes,data) VALUES(?,?,?,?)')
      .run('legacy', 1, 1, 'x'.repeat(100000)); // Do not trust legacy byte-count metadata.
    raw.prepare('INSERT INTO terminal_logs(terminal_id,created_at,bytes,data) VALUES(?,?,?,?)')
      .run('invalid-utf8', 1, 1, Buffer.from([0xff]));
    expect(() => store.readLogPage('legacy')).toThrow('no cursor consumed');
    expect(() => store.readLogPage('legacy')).toThrow('no cursor consumed');
    expect(() => store.readLogPage('invalid-utf8')).toThrow(/encoding|utf-8/u);
  } finally { raw.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
