import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import type { LocalScope } from '@cloudhelm/contracts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

it.each(['revocation', 'cancellation'])('rechecks %s after asynchronous file-handle cleanup', async (mode) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-read-cleanup-')));
  const scopes: LocalScope[] = [{ path: root, kind: 'directory' }];
  const controller = new AbortController();
  try {
    const file = path.join(root, 'selected.txt'); await writeFile(file, 'must not be delivered');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (requested, flags) => {
      const handle = await actual.open(requested, flags);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (mode === 'revocation') scopes.splice(0); else controller.abort();
      };
      return handle;
    });
    await expect(new LocalFileAccess(scopes).read(file, controller.signal)).rejects.toThrow(/outside|abort/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports an inaccessible regular file size as null, not zero', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-directory-size-')));
  try {
    await writeFile(path.join(root, 'unknown.txt'), 'not empty');
    vi.mocked(lstat).mockImplementationOnce(async () => { throw Object.assign(new Error('fixture permission denial'), { code: 'EACCES' }); });
    const page = await new LocalFileAccess([{ path: root, kind: 'directory' }]).list(root);
    expect(page.entries).toEqual([{ name: 'unknown.txt', kind: 'file', size: null }]);
    expect(page.more).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not return partial directory data when cancelled during its metadata scan', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-directory-cancel-')));
  try {
    await writeFile(path.join(root, 'file.txt'), 'content');
    const controller = new AbortController();
    vi.mocked(lstat).mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error('fixture permission denial'), { code: 'EPERM' });
    });
    await expect(new LocalFileAccess([{ path: root, kind: 'directory' }]).list(root, undefined, controller.signal))
      .rejects.toThrow(/abort/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});
