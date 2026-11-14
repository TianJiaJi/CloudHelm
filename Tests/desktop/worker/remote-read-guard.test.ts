import { expect, it } from 'vitest';
import { assertRemoteReadAllowed, resolveRemoteReadTarget } from '../../../apps/desktop/src/worker/remote-read-guard.js';

it('resolves a literal remote read target and rejects control bytes or traversal', () => {
  expect(resolveRemoteReadTarget('/srv/app/main.py', '/')).toBe('/srv/app/main.py');
  expect(resolveRemoteReadTarget('main.py', '/srv/app')).toBe('/srv/app/main.py');
  expect(resolveRemoteReadTarget('./conf/../main.py', '/srv/app')).toBe('/srv/app/main.py');
  expect(() => resolveRemoteReadTarget('/srv/\u0007x', '/')).toThrow('Invalid remote read path');
  expect(() => resolveRemoteReadTarget('', '/')).toThrow('Invalid remote read path');
  expect(() => resolveRemoteReadTarget('/srv/' + 'x'.repeat(5000), '/')).toThrow('Invalid remote read path');
});

it('refuses user-protected trees and credential files, and allows ordinary sources', () => {
  const protectedPaths = ['/etc/nginx', '/srv/secrets'];
  expect(() => assertRemoteReadAllowed('/etc/nginx/nginx.conf', protectedPaths)).toThrow('Protected path');
  expect(() => assertRemoteReadAllowed('/srv/secrets/a', protectedPaths)).toThrow('Protected path');
  expect(() => assertRemoteReadAllowed('/srv/private/a', ['/srv/app/../private/'])).toThrow('Protected path');
  expect(() => assertRemoteReadAllowed('/srv/../etc/shadow', [])).toThrow('Credential file');
  for (const target of ['/home/deploy/.ssh/id_ed25519', '/srv/app/.env.production', '/root/.Xauthority',
    '/etc/shadow', '/etc/gshadow', '/root/.ssh/authorized_keys']) {
    expect(() => assertRemoteReadAllowed(target, [])).toThrow('Credential file');
  }
  expect(() => assertRemoteReadAllowed('/srv/app/main.py', protectedPaths)).not.toThrow();
  expect(() => assertRemoteReadAllowed('/etc/nginx-other/site.conf', protectedPaths)).not.toThrow();
});
