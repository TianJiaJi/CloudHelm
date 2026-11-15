import { expect, it, vi } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

function fixture() {
  const refused = vi.fn(), dispatch = vi.fn(() => { throw new Error('No dispatch expected'); });
  const deps = { hosts: [{ id: 'host', label: 'fixture', username: 'user', address: '192.0.2.1', port: 22,
    auth: 'agent', status: 'connected', defaultMode: 'ask', policyRevision: 1, protectedPaths: [] } as RuntimeHost],
  localFiles: new LocalFileAccess([]), ensureTerminal: dispatch, scope: dispatch, runOperation: dispatch, refused } as unknown as RemoteToolDependencies;
  return { deps, refused, tools: createRemoteTools(deps, {} as SafetyGate) };
}

it('reports a fixed refusal code for pre-dispatch rejections without touching the host', async () => {
  const f = fixture(), remote = f.tools.find((tool) => tool.name === 'run_remote')!;
  expect(await remote.execute('call', { hostId: 'foreign', command: 'id' } as never)).toMatchObject({ isError: true });
  expect(f.refused).toHaveBeenLastCalledWith('run_remote', 'out-of-scope-host');
  expect(await remote.execute('call', { hostId: 'host', command: 'id', privilege: 'root', sessionId: 'legacy' } as never))
    .toMatchObject({ isError: true });
  expect(f.refused).toHaveBeenLastCalledWith('run_remote', 'conflicting-identity');
  const write = f.tools.find((tool) => tool.name === 'write_remote_file')!;
  expect(await write.execute('call', { hostId: 'host', path: '/srv/a', content: 'x', createOnly: true,
    expectedSha256: 'a'.repeat(64) } as never)).toMatchObject({ isError: true });
  expect(f.refused).toHaveBeenLastCalledWith('write_remote_file', 'invalid-file-condition');
  expect(f.refused.mock.calls.every((call) => call.length === 2)).toBe(true);
});

it('keeps tool capabilities, query visibility and successful results unchanged', async () => {
  const plain = fixture().tools, observed = fixture().tools;
  for (const tool of observed) {
    const original = plain.find((item) => item.name === tool.name)!;
    expect(tool.access).toBe(original.access); expect(tool.replay).toBe(original.replay);
    expect(tool.available?.()).toBe(original.available?.());
  }
  const f = fixture(), read = f.tools.find((tool) => tool.name === 'read_remote_file')!;
  expect(read.access).toBe('query');
  expect(await read.execute('call', { hostId: 'host', path: '/srv/a' } as never)).toMatchObject({ isError: true });
  expect(f.refused).toHaveBeenCalledWith('read_remote_file', expect.stringMatching(/^[a-z0-9-]{1,64}$/u));
});
