import { expect, it, vi } from 'vitest';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { ManualSessionAuthorization } from '../../../apps/desktop/src/worker/manual-session-authorization.js';

const host: RuntimeHost = { id: 'host', label: 'Fixture', address: 'host.test', port: 22, username: 'user', auth: 'password',
  status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1,
  credentials: { password: 'must-not-enter-prompt', proxyPassword: 'private-proxy-password' },
  connection: { version: 1, terminal: { term: 'vt100' }, session: { directory: '/srv', initialization: 'printf startup',
    keepaliveCommand: 'printf heartbeat', keepaliveIntervalMs: 10000, environment: [{ name: 'LANG', value: 'C.UTF-8' }] },
    x11: { enabled: true, display: 0, screen: 0, cookie: 'auto' } } };
function setup() {
  let generation = 2, connected = true;
  const input = vi.fn(async () => '应用配置并打开终端' as string | null);
  const auth = new ManualSessionAuthorization({ input, generation: () => generation, connected: () => connected });
  return { auth, input, change: () => { generation++; }, disconnect: () => { connected = false; auth.disconnect(host.id); } };
}
it('binds human consent to the recipient, captured configuration and real connection generation', async () => {
  const f = setup(), mutable = structuredClone(host), grant = await f.auth.authorize(mutable);
  expect(f.input).toHaveBeenCalledOnce(); expect(JSON.stringify(f.input.mock.calls)).not.toContain('must-not-enter-prompt');
  expect(JSON.stringify(f.input.mock.calls)).not.toContain('private-proxy-password');
  mutable.connection!.session!.initialization = 'unapproved replacement';
  expect(grant.settings.session!.initialization).toBe('printf startup');
  grant.assertCurrent(); f.change(); expect(() => grant.assertCurrent()).toThrow('连接已变化'); grant.close();
});
it('permits a basic terminal only after that explicit choice, without environment, commands or X11', async () => {
  const f = setup(); f.input.mockResolvedValue('仅打开基础终端（不执行配置命令或启用X11）');
  const grant = await f.auth.authorize(host);
  expect(grant.settings.session).toEqual({ directory: '/srv' }); expect(grant.settings.x11).toBeUndefined();
  expect(grant.settings.terminal?.term).toBe('vt100'); grant.close();
});
it.each([null, 'unexpected answer'])('does not fall back to commands or a basic terminal on cancellation: %s', async (answer) => {
  const f = setup(); f.input.mockResolvedValue(answer);
  await expect(f.auth.authorize(host)).rejects.toThrow('没有发送配置命令');
});
it('revokes an in-flight consent request on disconnect and rejects a late approval', async () => {
  const f = setup(); let resolve!: (answer: string) => void;
  f.input.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = f.auth.authorize(host); f.disconnect(); resolve('应用配置并打开终端');
  await expect(pending).rejects.toThrow();
});
it('does not create overlapping consent requests for the same recipient', async () => {
  const f = setup(); let resolve!: (answer: string) => void;
  f.input.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = f.auth.authorize(host);
  await expect(f.auth.authorize(host)).rejects.toThrow('等待确认');
  resolve('应用配置并打开终端'); (await pending).close(); expect(f.input).toHaveBeenCalledOnce();
});
it('uses ordinary terminal parameters without prompting when no executable configuration or X11 is enabled', async () => {
  const f = setup(), grant = await f.auth.authorize({ ...host, connection: { version: 1, terminal: { term: 'vt100' }, session: { directory: '~/work' } } });
  expect(f.input).not.toHaveBeenCalled(); grant.assertCurrent(); grant.close(); expect(() => grant.assertCurrent()).toThrow();
});
