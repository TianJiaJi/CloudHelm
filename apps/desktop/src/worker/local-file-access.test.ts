import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { LocalScope } from '@cloudhelm/contracts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalFileAccess } from './local-file-access.js';

describe('user-selected local scope', () => {
  it('pages a stable sorted directory without omissions and reports actual UTF-8 file sizes', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-directory-pages-')));
    try {
      await Promise.all(Array.from({ length: 451 }, (_, i) => writeFile(path.join(root, `file-${String(i).padStart(3, '0')}.txt`), i ? '行🙂' : '')));
      const access = new LocalFileAccess([{ path: root, kind: 'directory' }]);
      const first = await access.list(root);
      expect(first.entries).toHaveLength(200);
      expect(first.entries[0]).toEqual({ name: 'file-000.txt', kind: 'file', size: 0 });
      expect(first.entries[1]?.size).toBe(Buffer.byteLength('行🙂'));
      expect(first).toMatchObject({ more: true, totalEntries: 451 });
      const second = await access.list(root, first.nextCursor);
      const last = await access.list(root, second.nextCursor);
      expect(second.entries).toHaveLength(200);
      expect(last.entries).toHaveLength(51);
      expect(last.more).toBe(false);
      expect(last.nextCursor).toBeUndefined();
      expect(second.version).toBe(first.version);
      const names = [...first.entries, ...second.entries, ...last.entries].map((entry) => entry.name);
      expect(names).toEqual([...names].sort());
      expect(new Set(names).size).toBe(451);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('invalidates cursors on directory/content changes and binds them to their authorized path and instance', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-directory-version-')));
    try {
      const left = path.join(root, 'left'); const right = path.join(root, 'right');
      await mkdir(left); await mkdir(right);
      await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(path.join(left, `file-${i}`), 'a')));
      const scopes: LocalScope[] = [{ path: root, kind: 'directory' }];
      const access = new LocalFileAccess(scopes);
      const first = await access.list(left);
      await expect(access.list(right, first.nextCursor)).rejects.toThrow(/cursor|游标/iu);
      await expect(new LocalFileAccess(scopes).list(left, first.nextCursor)).rejects.toThrow(/cursor|游标/iu);
      await expect(access.list(left, `${first.nextCursor}tamper`)).rejects.toThrow(/cursor|游标/iu);
      await writeFile(path.join(left, 'file-0'), 'different bytes');
      await expect(access.list(left, first.nextCursor)).rejects.toThrow(/changed|变化/iu);
      const refreshed = await access.list(left);
      await writeFile(path.join(left, 'added'), 'new');
      await expect(access.list(left, refreshed.nextCursor)).rejects.toThrow(/changed|变化/iu);
      const current = await access.list(left);
      scopes.splice(0);
      await expect(access.list(left, current.nextCursor)).rejects.toThrow('outside');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not traverse symlinks for metadata or continuation, and does not call unknown sizes zero', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-directory-links-')));
    const selected = path.join(root, 'selected'); const outside = path.join(root, 'outside');
    try {
      await mkdir(selected); await mkdir(outside); await mkdir(path.join(selected, 'nested'));
      await writeFile(path.join(outside, 'private.txt'), 'never returned');
      await symlink(outside, path.join(selected, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const access = new LocalFileAccess([{ path: selected, kind: 'directory' }]);
      const page = await access.list(selected);
      expect(page.entries.find((entry) => entry.name === 'escape')).toMatchObject({ kind: 'other', size: null });
      expect(page.entries.find((entry) => entry.name === 'nested')).toMatchObject({ kind: 'directory', size: null });
      expect(JSON.stringify(page)).not.toContain('private.txt');
      await expect(access.list(path.join(selected, 'escape'))).rejects.toThrow('outside');
      await rename(selected, path.join(root, 'original'));
      await symlink(outside, selected, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(access.list(selected)).rejects.toThrow('changed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects cancelled directory reads and rechecks scope for every text read', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-local-revoke-')));
    const scopes: LocalScope[] = [{ path: root, kind: 'directory' }];
    try {
      const file = path.join(root, 'text'); await writeFile(file, 'content');
      const access = new LocalFileAccess(scopes);
      const controller = new AbortController(); controller.abort();
      await expect(access.list(root, undefined, controller.signal)).rejects.toThrow(/abort/iu);
      expect((await access.read(file)).data.toString()).toBe('content');
      scopes.splice(0);
      await expect(access.read(file)).rejects.toThrow('outside');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reads the selected tree but refuses both traversal and symlinks escaping it', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-local-')));
    const selected = path.join(root, 'selected');
    const outsideDirectory = path.join(root, 'outside');
    const outside = path.join(outsideDirectory, 'private.txt');
    const escape = path.join(selected, 'escape');
    try {
      await mkdir(selected);
      await mkdir(outsideDirectory);
      await writeFile(path.join(selected, 'allowed.txt'), 'allowed');
      await writeFile(outside, 'private');
      await symlink(outsideDirectory, escape, process.platform === 'win32' ? 'junction' : 'dir');
      const access = new LocalFileAccess([{ path: selected, kind: 'directory' }]);
      expect((await access.read(path.join(selected, 'allowed.txt'))).data.toString()).toBe('allowed');
      await expect(access.read(outside)).rejects.toThrow('outside');
      await expect(access.read(path.join(escape, 'private.txt'))).rejects.toThrow('outside');
      await expect(access.read(path.join(selected, '..', 'outside', 'private.txt'))).rejects.toThrow('outside');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
