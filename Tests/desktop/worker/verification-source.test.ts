import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import type { OperationScope } from '@cloudhelm/core';
import { verificationSource } from '../../../apps/desktop/src/worker/verification-source.js';
const analyzer = new BashAnalyzer();
const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv', loginAs: 'user', runAs: 'user', terminalId: 'terminal',
  goal: 'write file', terminalGeneration: 1, policyRevision: 1, protectedPaths: [], allowedWorkingRoots: ['/srv'] };
it('binds only literal single-file cat reads from full source, including reviewed sudo, never previews', async () => {
  for (const command of ['cat test.py', 'cat -- /srv/test.py', 'sudo cat /srv/test.py']) {
    expect(await verificationSource({ id: 'read', kind: 'command', command, scope }, analyzer)).toEqual({ kind: 'file-read', path: '/srv/test.py' });
  }
  for (const command of ['stat /srv/test.py', 'cat *.py', 'cat /srv/test.py /tmp/other', 'cat /srv/test.py; cat /tmp/other', 'cat "$FILE"', 'cat -', 'cat /srv/test.py > /tmp/out']) {
    expect(await verificationSource({ id: 'read', kind: 'command', command, scope }, analyzer)).toBeUndefined();
  }
});
it('stores only the digest of written bytes, not file contents', async () => {
  const source = await verificationSource({ id: 'write', kind: 'write-file', path: 'test.py', content: 'private contents', scope }, analyzer);
  expect(source).toMatchObject({ kind: 'file-write', path: '/srv/test.py', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(JSON.stringify(source)).not.toContain('private contents');
});
