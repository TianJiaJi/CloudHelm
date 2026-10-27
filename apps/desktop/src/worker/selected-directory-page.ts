import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, opendir, stat } from 'node:fs/promises';
import type { BigIntStats, Dirent } from 'node:fs';
import path from 'node:path';

export interface SelectedDirectoryEntry { name: string; kind: 'file' | 'directory' | 'other'; size: number | null }
export interface SelectedDirectoryPage {
  entries: SelectedDirectoryEntry[]; version: string; totalEntries: number; more: boolean; nextCursor?: string;
}
interface Cursor { v: 1; binding: string; version: string; offset: number }
interface StampedEntry { entry: SelectedDirectoryEntry; stamp: string[] }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = (value: BigIntStats) => [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String);
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Operation aborted'); };

function encodeCursor(value: Cursor, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function decodeCursor(value: string, key: Buffer, binding: string): Cursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error();
    const [body, signature] = value.split('.') as [string, string];
    const expected = createHmac('sha256', key).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    const cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor;
    if (cursor.v !== 1 || cursor.binding !== binding || !/^[a-f0-9]{64}$/u.test(cursor.version)
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 || cursor.offset > 10_000) throw new Error();
    return cursor;
  } catch { throw new Error('Directory cursor is invalid, expired or belongs to another path; list the selected path again'); }
}

async function entryMetadata(root: string, entry: Dirent): Promise<StampedEntry> {
  try {
    // lstat never follows a directory member symlink/junction to its target.
    const metadata = await lstat(path.join(root, entry.name), { bigint: true });
    const regular = metadata.isFile() && !metadata.isSymbolicLink();
    return { entry: { name: entry.name, kind: regular ? 'file' : !metadata.isSymbolicLink() && metadata.isDirectory() ? 'directory' : 'other',
      size: regular && metadata.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(metadata.size) : null }, stamp: stamp(metadata) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw new Error('Directory changed or metadata is unavailable; list it again');
    return { entry: { name: entry.name, kind: entry.isSymbolicLink() ? 'other' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other', size: null },
      stamp: ['metadata-unavailable', code] };
  }
}

/** Metadata-only paging inside a path authorized by LocalFileAccess before AND
 * after this call. Cursor possession never grants read authority. */
export async function selectedDirectoryPage(actual: string, scopeRoot: string, key: Buffer, token?: string,
  signal?: AbortSignal): Promise<SelectedDirectoryPage> {
  aborted(signal);
  const binding = digest([scopeRoot, actual]);
  const cursor = token === undefined ? undefined : decodeCursor(token, key, binding);
  const before = await stat(actual, { bigint: true });
  if (!before.isDirectory()) throw new Error('Selected path is not a directory');
  const names: Dirent[] = [];
  for await (const entry of await opendir(actual)) {
    aborted(signal);
    names.push(entry);
    // A bound on backend work, not silent truncation of the directory listing.
    if (names.length > 10_000) throw new Error('Directory exceeds the bounded metadata scan; choose a narrower selected directory');
  }
  names.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const observed: StampedEntry[] = [];
  for (let offset = 0; offset < names.length; offset += 16) {
    aborted(signal);
    observed.push(...await Promise.all(names.slice(offset, offset + 16).map((entry) => entryMetadata(actual, entry))));
  }
  aborted(signal);
  const after = await stat(actual, { bigint: true });
  if (JSON.stringify(stamp(before)) !== JSON.stringify(stamp(after))) throw new Error('Directory changed during listing; start again');
  const version = digest([stamp(before), observed]);
  if (cursor && cursor.version !== version) throw new Error('Directory changed since the previous page; start again');
  const start = cursor?.offset ?? 0;
  if (start > observed.length) throw new Error('Directory cursor is outside the current listing; start again');
  const entries: SelectedDirectoryEntry[] = [];
  let bytes = 0;
  for (const { entry } of observed.slice(start, start + 200)) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > 48 * 1024) break;
    entries.push(entry); bytes += size;
  }
  if (!entries.length && start < observed.length) throw new Error('Directory entry exceeds the bounded page size');
  const end = start + entries.length;
  const more = end < observed.length;
  return { entries, version, totalEntries: observed.length, more,
    ...(more ? { nextCursor: encodeCursor({ v: 1, binding, version, offset: end }, key) } : {}) };
}
