import { expect, it, vi } from 'vitest';
import type { BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';

it('masks file secrets in both projections and withholds the overwrite hash', async () => {
  const raw = 'password="first\nsecond"\nhello\n';
  const readRemoteFile = vi.fn(async () => ({ content: raw, bytes: raw.length, truncated: false,
    sha256: 'a'.repeat(64), mode: 0o644, uid: 1, gid: 1 }));
  const never = vi.fn(() => { throw new Error('No remote dispatch'); });
  const deps = { hosts: [{ id: 'host' }], localFiles: new LocalFileAccess([]), readRemoteFile,
    ensureTerminal: never, runOperation: never, scope: never } as unknown as RemoteToolDependencies;
  const tool = createRemoteTools(deps, {} as SafetyGate).find((item) => item.name === 'read_remote_file') as BusinessTool<{
    hostId: string; path: string; maxBytes: number;
  }>;
  const result = await tool.execute('read', { hostId: 'host', path: '/srv/config', maxBytes: 4096 });
  expect(JSON.stringify(result)).not.toMatch(/first|second/u);
  expect(result.details).toMatchObject({ redacted: true, sha256: null });
  expect(readRemoteFile).toHaveBeenCalledWith('host', '/srv/config', undefined, undefined, 4096);
  expect(never).not.toHaveBeenCalled();
});
