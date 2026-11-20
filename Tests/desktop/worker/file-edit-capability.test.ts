import { expect, it, vi } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import { executionGuidelines } from '../../../apps/desktop/src/worker/agent-prompt.js';

function fixture() {
  const readRemoteFile = vi.fn(async () => ({ content: 'port=80\n', bytes: 8, truncated: false,
    sha256: 'a'.repeat(64), mode: 0o600, uid: 1, gid: 1 }));
  const ensureTerminal = vi.fn(async () => 'terminal'), runOperation = vi.fn();
  const tools = createRemoteTools({ hosts: [{ id: 'host', label: 'fixture', username: 'user' } as RuntimeHost],
    localFiles: new LocalFileAccess([]), readRemoteFile, ensureTerminal, runOperation,
    scope: () => ({ taskId: 'task', hostId: 'host', cwd: '/', runAs: 'user', terminalId: 'terminal', terminalGeneration: 1,
      policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' }) }, {} as SafetyGate);
  return { tools, readRemoteFile, ensureTerminal, runOperation };
}

it('removed the legacy edit commit tool from the registry entirely', () => {
  const f = fixture();
  expect(f.tools.find((tool) => tool.name === 'edit_remote_file')).toBeUndefined();
});

it('refuses a known unsupported replacement hash before terminal allocation or review', async () => {
  const f = fixture(), tool = f.tools.find((tool) => tool.name === 'write_remote_file')!;
  expect(await tool.execute('write', { hostId: 'host', path: '/srv/config', content: 'port=90\n', expectedSha256: 'a'.repeat(64) } as never))
    .toMatchObject({ isError: true, details: { code: 'remote-edit-unsupported', execution: 'not-started' } });
  expect(f.ensureTerminal).not.toHaveBeenCalled(); expect(f.runOperation).not.toHaveBeenCalled();
});

it('does not instruct the model to bypass the SFTP metadata refusal with sudo install', () => {
  expect(executionGuidelines).not.toContain('sudo install');
  expect(executionGuidelines).not.toContain('write_remote_file privately backs up');
  expect(executionGuidelines).toContain('prepare_remote_edit');
});
