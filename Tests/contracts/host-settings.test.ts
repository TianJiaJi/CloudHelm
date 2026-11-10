import { expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { SshConnectionSettingsSchema, SSH_ALGORITHM_CHOICES, type SshConnectionSettings } from '../../packages/contracts/src/host-settings.js';
import type { SshConnectionSettings as CoreSettings } from '../../packages/core/src/ssh-settings.js';

// This literal is deliberately not cast: compilation must catch erased unions,
// and adapter/core settings must remain structurally compatible with IPC settings.
const complete: SshConnectionSettings = { version: 1, authOrder: ['password', 'private-key', 'keyboard-interactive'],
  timeoutMs: 30000, keepaliveIntervalMs: 15000, keepaliveCountMax: 3,
  proxy: { enabled: true, protocol: 'socks5', address: '127.0.0.1', port: 1080, username: 'fixture' },
  terminal: { encoding: 'gbk', term: 'xterm-256color' }, files: { watch: false, followCwd: false },
  algorithms: { hostKey: ['rsa-sha2-512'], cipher: ['aes256-ctr'], kex: ['curve25519-sha256'] },
  x11: { enabled: true, display: 0, screen: 0, cookie: 'manual' },
  session: { directory: '~/work', initialization: 'printf ready', keepaliveCommand: 'true', keepaliveIntervalMs: 30000,
    environment: [{ name: 'LANG', value: 'C.UTF-8' }] } };
const adapterSettings: CoreSettings = complete;
it('retains the full public settings shape with valid static and runtime types', () => {
  expect(Value.Check(SshConnectionSettingsSchema, complete)).toBe(true); expect(adapterSettings).toEqual(complete);
});
it.each(Object.entries(SSH_ALGORITHM_CHOICES))('accepts every exposed %s algorithm and rejects unknown names', (kind, choices) => {
  for (const choice of choices) expect(Value.Check(SshConnectionSettingsSchema, { version: 1, algorithms: { [kind]: [choice] } })).toBe(true);
  expect(Value.Check(SshConnectionSettingsSchema, { version: 1, algorithms: { [kind]: ['invented'] } })).toBe(false);
});
it('rejects credentials embedded into public settings instead of exposing them in snapshots', () => {
  expect(Value.Check(SshConnectionSettingsSchema, { ...complete, proxy: { ...complete.proxy, password: 'secret' } })).toBe(false);
  expect(Value.Check(SshConnectionSettingsSchema, { ...complete, x11: { ...complete.x11, value: 'secret-cookie' } })).toBe(false);
});
