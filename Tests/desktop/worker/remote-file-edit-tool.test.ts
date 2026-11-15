import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import type { ProposedOperation } from '@cloudhelm/core';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import { createRemoteFileEditTool } from '../../../apps/desktop/src/worker/remote-file-edit-tool.js';

function fixture(source = 'port=8080\n') {
  const sha256 = createHash('sha256').update(source).digest('hex');
  const scope = { taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal',
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'edit' };
  const readRemoteFile = vi.fn(async () => ({ content: source, bytes: Buffer.byteLength(source), truncated: false,
    sha256, mode: 0o640, uid: 1, gid: 1 }));
  const runOperation = vi.fn(async (_gate: SafetyGate, _operation: ProposedOperation) => ({ content: [], details: {}, isError: false }));
  const ensureTerminal = vi.fn(async () => 'terminal');
  const tool = createRemoteFileEditTool({ hosts: [{ id: 'host', label: 'fixture' } as never],
    localFiles: new LocalFileAccess([]), readRemoteFile, ensureTerminal, scope: () => scope, runOperation }, {} as SafetyGate);
  return { tool, sha256, runOperation, ensureTerminal };
}

it('refuses the legacy commit without allocating a terminal or dispatching a write', async () => {
  const f = fixture();
  expect(await f.tool.execute('edit', { hostId: 'host', path: '/srv/config', expectedSha256: f.sha256, oldText: '8080', newText: '9090' }))
    .toMatchObject({ isError: true, details: { code: 'remote-edit-unsupported', execution: 'not-started' } });
  expect(f.runOperation).not.toHaveBeenCalled(); expect(f.ensureTerminal).not.toHaveBeenCalled();
});

it('does not let different hashes or fragments bypass the unsupported commit boundary', async () => {
  const f = fixture('aaa');
  const args = { hostId: 'host', path: '/srv/config', expectedSha256: f.sha256, oldText: 'aa', newText: 'b' };
  expect(await f.tool.execute('ambiguous', args)).toMatchObject({ isError: true, details: { code: 'remote-edit-unsupported' } });
  expect(await f.tool.execute('stale', { ...args, expectedSha256: '0'.repeat(64) }))
    .toMatchObject({ isError: true, details: { code: 'remote-edit-unsupported' } });
  expect(f.ensureTerminal).not.toHaveBeenCalled();
  expect(f.runOperation).not.toHaveBeenCalled();
});

it('never uses redacted source as an editable original and does not echo secrets', async () => {
  const f = fixture('password="synthetic-hidden"\nport=8080\n');
  const result = await f.tool.execute('masked', { hostId: 'host', path: '/srv/config', expectedSha256: f.sha256,
    oldText: '8080', newText: '9090' });
  expect(result).toMatchObject({ isError: true, details: { code: 'remote-edit-unsupported' } });
  expect(JSON.stringify(result)).not.toContain('synthetic-hidden');
  expect(f.ensureTerminal).not.toHaveBeenCalled();
});
