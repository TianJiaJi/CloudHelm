import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionDirectoryCleanup } from '../../packages/adapters/src/session-directory-cleanup.js';

afterEach(() => vi.restoreAllMocks());
it('coalesces duplicate disposal and requests finite Windows lock retries', async () => {
  const remove = vi.fn(async () => {});
  const cleanup = sessionDirectoryCleanup('/synthetic-owned-directory', remove);
  const first = cleanup();
  expect(cleanup()).toBe(first);
  expect(await first).toEqual({ status: 'removed' });
  expect(await cleanup()).toEqual({ status: 'removed' });
  expect(remove).toHaveBeenCalledExactlyOnceWith('/synthetic-owned-directory', {
    recursive: true, force: true, maxRetries: 4, retryDelay: 100
  });
});
it.each(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EIO'])(
  'reports a final %s failure as a sanitized result, not an unhandled rejection', async (code) => {
    const report = vi.fn();
    const remove = vi.fn(async () => { throw Object.assign(new Error('private directory and session content'), { code }); });
    const cleanup = sessionDirectoryCleanup('/private-session-path', remove, report);
    expect(await cleanup()).toMatchObject({ status: 'failed' });
    expect(await cleanup()).toMatchObject({ status: 'failed' });
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|content/u);
    expect(remove).toHaveBeenCalledOnce();
  });
it('uses a fixed warning category without the native exception body or path', async () => {
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const cleanup = sessionDirectoryCleanup('/private-session-path', async () => { throw new Error('private contents'); });
  expect(await cleanup()).toEqual({ status: 'failed', reason: 'io-error' });
  expect(warning).toHaveBeenCalledExactlyOnceWith('CloudHelm temporary session directory cleanup failed (io-error)',
    { code: 'CLOUDHELM_SESSION_CLEANUP_FAILED' });
});
it('removes only the owned ephemeral directory, not neighboring durable storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloudhelm-cleanup-test-'));
  try {
    const owned = await mkdtemp(join(root, 'owned-'));
    const durable = join(root, 'durable.json');
    await writeFile(join(owned, 'settings.json'), '{}');
    await writeFile(durable, 'keep');
    const cleanup = sessionDirectoryCleanup(owned);
    expect(await cleanup()).toEqual({ status: 'removed' });
    expect(await readFile(durable, 'utf8')).toBe('keep');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
});
