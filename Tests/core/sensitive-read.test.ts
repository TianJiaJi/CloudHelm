import { expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, isSensitiveReadPath, type OperationScope } from '@cloudhelm/core';
import { assertRemoteReadAllowed } from '../../apps/desktop/src/worker/remote-read-guard.js';

it('shares conservative sensitive defaults between SFTP and recognized command reads', async () => {
  const scope: OperationScope = { taskId: 'task', hostId: 'host', cwd: '/srv', runAs: 'user', terminalId: 'terminal',
    terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: 'inspect' };
  const analyzer = new BashAnalyzer();
  for (const target of ['/etc/shadow', '/srv/app/.env', '/srv/certs/private.pem', '/srv/certs/private.KEY',
    '/srv/backup/id_rsa', '/home/user/.ssh/id_ed25519', '/srv/key.p12', '/srv/cert.key.bak']) {
    expect(isSensitiveReadPath(target)).toBe(true);
    expect(() => assertRemoteReadAllowed(target, [])).toThrow('Credential file');
    const command = `cat ${target}`;
    expect(decideSafety({ id: 'read', kind: 'command', command, scope }, { mode: 'permissive', revision: 1 },
      await analyzer.analyze(command))).toMatchObject({ verdict: 'deny', ruleId: 'credential-resource' });
  }
});

it('keeps explicit application-secret rules configurable as files or subtrees', () => {
  const target = '/home/app/config/secret.yaml';
  expect(isSensitiveReadPath(target)).toBe(false);
  expect(() => assertRemoteReadAllowed(target, [target])).toThrow('Protected path');
  expect(() => assertRemoteReadAllowed(target, ['/home/app/config'])).toThrow('Protected path');
  expect(() => assertRemoteReadAllowed('/home/app/config-other/public.yaml', ['/home/app/config'])).not.toThrow();
});
