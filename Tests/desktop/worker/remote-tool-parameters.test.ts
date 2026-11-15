import { expect, it, vi } from 'vitest';
import type { SafetyGate } from '@cloudhelm/application';
import { assertStrictToolArguments, toPiTool } from '../../../packages/adapters/src/pi-tool-validation.js';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

function fixture() {
  const dispatch = vi.fn(() => { throw new Error('No allocation/dispatch expected'); });
  const deps = { hosts: [{ id: 'host' }], localFiles: new LocalFileAccess([]),
    ensureTerminal: dispatch, scope: dispatch, runOperation: dispatch } as unknown as RemoteToolDependencies;
  return { dispatch, tools: createRemoteTools(deps, {} as SafetyGate) };
}

it('publishes closed parameter objects and refuses unsupported fields before execution', async () => {
  const f = fixture();
  for (const tool of f.tools) expect(tool.parameters).toMatchObject({ additionalProperties: false });
  const tool = f.tools.find((item) => item.name === 'write_remote_file')!;
  const args = { hostId: 'host', path: '/srv/a', content: 'text' };
  expect(() => assertStrictToolArguments(tool.parameters, args)).not.toThrow();
  for (const field of ['privilege', 'sudo', 'preserveSpecialMode', 'unknownFlag']) {
    const piTool = toPiTool(tool);
    await expect(piTool.execute('call', { ...args, [field]: 'root' }, new AbortController().signal,
      undefined, {} as never)).rejects.toThrow('未执行');
  }
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('keeps preview input closed and refuses identity or approval claims', () => {
  const f = fixture(), tool = f.tools.find((item) => item.name === 'prepare_remote_edit')!;
  const args = { hostId: 'host', path: '/srv/config', expectedSha256: 'a'.repeat(64), oldText: '80', newText: '90' };
  expect(() => assertStrictToolArguments(tool.parameters, args)).not.toThrow();
  for (const field of ['privilege', 'sessionId', 'sudo', 'editId', 'approved'])
    expect(() => assertStrictToolArguments(tool.parameters, { ...args, [field]: 'root' })).toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('rejects identity conflicts and contradictory file conditions before allocating a terminal', async () => {
  const f = fixture();
  const command = f.tools.find((item) => item.name === 'run_remote')!;
  expect(await command.execute('command', { hostId: 'host', command: 'id', privilege: 'root', sessionId: 'legacy' } as never))
    .toMatchObject({ isError: true, details: { code: 'conflicting-identity' } });
  const write = f.tools.find((item) => item.name === 'write_remote_file')!;
  expect(await write.execute('write', { hostId: 'host', path: '/srv/a', content: 'text', createOnly: true,
    expectedSha256: 'a'.repeat(64) } as never)).toMatchObject({ isError: true, details: { code: 'invalid-file-condition' } });
  expect(f.dispatch).not.toHaveBeenCalled();
});
