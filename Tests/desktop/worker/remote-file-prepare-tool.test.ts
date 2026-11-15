import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';
import { createRemoteFilePrepareTool } from '../../../apps/desktop/src/worker/remote-file-prepare-tool.js';

function fixture(source = 'port=80\n') {
  const sha256 = createHash('sha256').update(source).digest('hex');
  const host = { id: 'host', label: 'fixture', username: 'user', policyRevision: 1, protectedPaths: [] } as unknown as RuntimeHost;
  const snapshot = { content: source, bytes: Buffer.byteLength(source), truncated: false, redacted: false, sha256, mode: 0o640, uid: 1, gid: 2 };
  const readRemoteFile = vi.fn<NonNullable<RemoteToolDependencies['readRemoteFile']>>(async () => snapshot), runOperation = vi.fn(), ensureTerminal = vi.fn();
  const tool = createRemoteFilePrepareTool({ hosts: [host], localFiles: new LocalFileAccess([]), readRemoteFile,
    runOperation, ensureTerminal, scope: vi.fn() });
  const args = { hostId: 'host', path: '/srv/config', expectedSha256: sha256, oldText: '80', newText: '90' };
  return { tool, args, host, snapshot, readRemoteFile, runOperation, ensureTerminal };
}

it('returns a complete version-bound read-only diff, never a commit token or a terminal', async () => {
  const f = fixture();
  expect(f.tool).toMatchObject({ name: 'prepare_remote_edit', access: 'query', deferred: true });
  const result = await f.tool.execute('preview', f.args);
  expect(result).toMatchObject({ isError: false, readOnly: true, structuredContent: { hostId: 'host', path: '/srv/config',
    previewOnly: true, completeDiff: true, commitSupported: false, sourceSha256: f.args.expectedSha256,
    targetSha256: createHash('sha256').update('port=90\n').digest('hex'),
    metadata: { mode: '640', uid: 1, gid: 2, aclXattr: 'unverified' },
    diff: '--- before\n+++ after\n@@ -1,1 +1,1 @@\n-port=80\n+port=90\n' } });
  expect(f.readRemoteFile).toHaveBeenCalledWith('host', '/srv/config', '/', undefined, 1048576);
  expect(result.structuredContent).not.toHaveProperty('editId');
  expect(result.structuredContent).not.toHaveProperty('approvalId');
  expect(f.ensureTerminal).not.toHaveBeenCalled(); expect(f.runOperation).not.toHaveBeenCalled();
});

it('keeps denied attempts on the audited read port and does not fall back to another reader', async () => {
  const f = fixture(); f.readRemoteFile.mockRejectedValue(new Error('Host is outside authorization'));
  expect(await f.tool.execute('denied', { ...f.args, hostId: 'foreign' })).toMatchObject({ isError: true,
    details: { code: 'remote-edit-unavailable', effects: 'none' } });
  expect(f.readRemoteFile).toHaveBeenCalledWith('foreign', '/srv/config', '/', undefined, 1048576);
  expect(f.runOperation).not.toHaveBeenCalled(); expect(f.ensureTerminal).not.toHaveBeenCalled();
});

it('discards a preview when policy changes during its read', async () => {
  const f = fixture();
  f.readRemoteFile.mockImplementation(async () => { f.host.policyRevision++; return f.snapshot; });
  const result = await f.tool.execute('stale', f.args);
  expect(result).toMatchObject({ isError: true, details: { code: 'remote-edit-unavailable' } });
  expect(JSON.stringify(result)).not.toContain('port='); expect(result.structuredContent).not.toHaveProperty('targetSha256');
});

it('propagates cancellation and never delivers a late reader result', async () => {
  const f = fixture(), controller = new AbortController();
  f.readRemoteFile.mockImplementation(async () => { controller.abort(); return f.snapshot; });
  const result = await f.tool.execute('canceled', f.args, controller.signal);
  expect(result).toMatchObject({ isError: true });
  expect(f.readRemoteFile.mock.calls[0]?.[3]).toBe(controller.signal);
  expect(JSON.stringify(result)).not.toContain('port=');
  expect(f.runOperation).not.toHaveBeenCalled(); expect(f.ensureTerminal).not.toHaveBeenCalled();
});

it.each(['truncated', 'redacted'] as const)('never previews or provides hashes for %s source', async (field) => {
  const f = fixture(); f.snapshot[field] = true;
  const result = await f.tool.execute('incomplete', f.args);
  expect(result).toMatchObject({ isError: true });
  expect(result.structuredContent).not.toHaveProperty('sourceSha256'); expect(result.structuredContent).not.toHaveProperty('targetSha256');
  expect(JSON.stringify(result)).not.toContain('port=');
});

it('refuses JSON-expanding previews rather than clipping the structured diff', async () => {
  const f = fixture('\\'.repeat(26000) + 'x\n');
  const result = await f.tool.execute('bounded', { ...f.args, oldText: 'x', newText: 'y' });
  expect(result).toMatchObject({ isError: true, details: { code: 'remote-edit-diff-too-large' } });
  expect(result.structuredContent).not.toHaveProperty('diff');
  expect(result.structuredContent).not.toHaveProperty('targetSha256');
});

it('refuses proposed secrets without echoing the secret or a partial diff', async () => {
  const f = fixture();
  const result = await f.tool.execute('secret', { ...f.args, newText: '90\npassword="synthetic-preview-secret"' });
  expect(result).toMatchObject({ isError: true, details: { code: 'remote-edit-unavailable' } });
  expect(JSON.stringify(result)).not.toContain('synthetic-preview-secret');
  expect(result.structuredContent).not.toHaveProperty('diff');
});
