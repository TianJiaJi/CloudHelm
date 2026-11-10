import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostDraft, HostView } from '@cloudhelm/contracts';
import { SqliteStore } from '../../../packages/adapters/src/sqlite-store.js';
import { createHostSettings, editHostSettings, readHostCredentials } from '../../../apps/desktop/src/main/host-settings.js';

const stores: SqliteStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
const draft: HostDraft = { label: 'Fixture', address: 'host.test', port: 22, username: 'user', auth: 'password' };
function setup() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  const key = randomBytes(32);
  const encrypt = vi.fn((value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  });
  const secret = (id: string): string | undefined => {
    const encoded = store.get<string>('secrets', id); if (encoded === undefined) return undefined;
    const bytes = Buffer.from(encoded, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  };
  return { store, hosts: new Map<string, HostView>(), encrypt, secret, publish: vi.fn() };
}
it('persists public settings and separately encrypted credentials without trusting extra renderer fields', () => {
  const context = setup();
  const host = createHostSettings(context, { ...draft, group: 'test', notes: 'fixture notes', connection: { version: 1,
    timeoutMs: 4000, terminal: { term: 'vt100', encoding: 'gbk' } }, password: 'injected', fingerprint: 'forged' } as HostDraft,
  { password: 'synthetic-login', passphrase: 'synthetic-key', proxyPassword: 'synthetic-proxy', x11Cookie: 'a'.repeat(32) });
  expect(host).toMatchObject({ group: 'test', notes: 'fixture notes', connection: { timeoutMs: 4000 } });
  expect(host.fingerprint).toBeUndefined(); expect(JSON.stringify(host)).not.toMatch(/injected|synthetic-login|synthetic-key|synthetic-proxy/u);
  expect(JSON.stringify(context.store.list('secrets'))).not.toContain('synthetic-login');
  expect(readHostCredentials(host, context.secret)).toEqual({ password: 'synthetic-login', passphrase: 'synthetic-key', proxyPassword: 'synthetic-proxy', x11Cookie: 'a'.repeat(32) });
});
it('keeps label/group/notes changes on the same identity, without touching credentials', () => {
  const context = setup(), host = createHostSettings(context, draft, { password: 'synthetic-login' }); context.encrypt.mockClear();
  const edited = editHostSettings(context, host.id, { ...draft, group: 'new-group', notes: 'new-notes', label: 'renamed' });
  expect(edited.id).toBe(host.id); expect(edited.group).toBe('new-group'); expect(context.encrypt).not.toHaveBeenCalled();
  expect(readHostCredentials(edited, context.secret).password).toBe('synthetic-login');
});
it.each([{ username: 'root' }, { address: 'other.test' }, { port: 2222 }, { auth: 'private-key' as const, privateKeyPath: '/synthetic/key' }])(
  'does not recycle login credentials across changed recipients: %j', (change) => {
    const context = setup(), host = createHostSettings(context, draft, { password: 'synthetic-login', passphrase: 'synthetic-key' });
    const edited = editHostSettings(context, host.id, { ...draft, ...change });
    expect(edited.id).not.toBe(host.id); expect(context.hosts.get(host.id)?.archived).toBe(true);
    expect(readHostCredentials(edited, context.secret)).toEqual({});
    expect(readHostCredentials(host, context.secret).password).toBe('synthetic-login');
  });
it('retains compatible credentials on new connection settings but does not change existing connections', () => {
  const context = setup(), host = createHostSettings(context, draft, { password: 'synthetic-login' });
  host.status = 'connected'; context.store.put('hosts', host.id, host);
  const edited = editHostSettings(context, host.id, { ...draft, connection: { version: 1, keepaliveIntervalMs: 0 } });
  expect(edited).toMatchObject({ status: 'disconnected', previousHostId: host.id });
  expect(context.hosts.get(host.id)).toMatchObject({ status: 'connected', archived: true });
  expect(readHostCredentials(edited, context.secret).password).toBe('synthetic-login');
});
it('explicit clearing cannot resurrect a legacy password', () => {
  const context = setup(), host = createHostSettings(context, draft);
  context.store.put('secrets', `host:${host.id}`, context.encrypt('legacy-password'));
  expect(readHostCredentials(host, context.secret)).toEqual({ password: 'legacy-password' });
  const edited = editHostSettings(context, host.id, draft, undefined, { password: null });
  context.store.put('secrets', `host:${edited.id}`, context.encrypt('stale-password'));
  expect(readHostCredentials(edited, context.secret)).toEqual({});
});
it('reads legacy key credentials only as key passphrases, never SSH passwords', () => {
  const context = setup(), host = createHostSettings(context, { ...draft, auth: 'private-key', privateKeyPath: '/synthetic/key' });
  context.store.put('secrets', `host:${host.id}`, context.encrypt('legacy-key-phrase'));
  expect(readHostCredentials(host, context.secret)).toEqual({ passphrase: 'legacy-key-phrase' });
});
it.each(['encrypt', 'write'] as const)('does not publish a partially-created host when %s fails', (failure) => {
  const context = setup();
  if (failure === 'encrypt') context.encrypt.mockImplementation(() => { throw new Error('fixture failure'); });
  else {
    const put = context.store.put.bind(context.store);
    vi.spyOn(context.store, 'put').mockImplementation((bucket, id, value) => { if (bucket === 'secrets') throw new Error('fixture failure'); put(bucket, id, value); });
  }
  expect(() => createHostSettings(context, draft, { password: 'synthetic-login' })).toThrow('fixture failure');
  expect(context.store.list('hosts')).toEqual([]); expect(context.hosts.size).toBe(0); expect(context.publish).not.toHaveBeenCalled();
});
it('atomically rolls back archive, replacement and credential writes on edit failure', () => {
  const context = setup(), original = createHostSettings(context, draft, { password: 'synthetic-login' }); context.publish.mockClear();
  const put = context.store.put.bind(context.store);
  vi.spyOn(context.store, 'put').mockImplementation((bucket, id, value) => { if (bucket === 'secrets') throw new Error('fixture failure'); put(bucket, id, value); });
  expect(() => editHostSettings(context, original.id, { ...draft, port: 2222 }, undefined, { password: 'new-password' })).toThrow('fixture failure');
  expect(context.store.list('hosts')).toEqual([original]); expect([...context.hosts.values()]).toEqual([original]); expect(context.publish).not.toHaveBeenCalled();
});
it.each([
  { ...draft, auth: 'agent' }, { ...draft, auth: 'private-key' },
  { ...draft, connection: { version: 1, timeoutMs: 0 } },
  { ...draft, connection: { version: 1, algorithms: { cipher: ['invented'] } } },
  { ...draft, connection: { version: 1, proxy: { enabled: true, protocol: 'http', address: 'proxy\r\nInjected', port: 80 } } },
  { ...draft, connection: { version: 1, session: { environment: [{ name: 'TOKEN', value: 'secret' }] } } },
  { ...draft, connection: { version: 1, session: { environment: [{ name: 'LANG', value: 'a' }, { name: 'LANG', value: 'b' }] } } },
  { ...draft, connection: { version: 1, session: { keepaliveCommand: 'true' } } }
])('rejects invalid or unsupported settings before writing anything', (input) => {
  const context = setup(); expect(() => createHostSettings(context, input as HostDraft)).toThrow();
  expect(context.hosts.size).toBe(0); expect(context.store.list('hosts')).toEqual([]); expect(context.encrypt).not.toHaveBeenCalled();
});
it('rejects multi-level jumps and preserves explicit treatment of legacy Agent records', () => {
  const context = setup(), jump = createHostSettings(context, draft), target = createHostSettings(context, { ...draft, jumpHostId: jump.id });
  expect(() => createHostSettings(context, { ...draft, jumpHostId: target.id })).toThrow('single jump');
  expect(() => editHostSettings(context, jump.id, { ...draft, jumpHostId: jump.id })).toThrow('single jump');
  const legacy = { ...jump, auth: 'agent' as const }; context.hosts.set(jump.id, legacy);
  expect(() => editHostSettings(context, jump.id, legacy)).toThrow('SSH Agent 已停用');
  expect(editHostSettings(context, jump.id, draft, undefined, { password: 'explicit-new-password' }).auth).toBe('password');
});
