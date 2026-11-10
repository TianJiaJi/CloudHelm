import { expect, it } from 'vitest';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { runtimeCallTimeout } from '../../../apps/desktop/src/main/runtime-timeout.js';

const host: RuntimeHost = { id: 'fixture', label: 'fixture', address: '127.0.0.1', port: 22, username: 'fixture', auth: 'password',
  status: 'disconnected', protectedPaths: [], defaultMode: 'ai-review', policyRevision: 1 };
it('preserves ordinary, test-host and model RPC limits', () => {
  expect(runtimeCallTimeout({ method: 'has-task', taskId: 'fixture' })).toBe(30000);
  expect(runtimeCallTimeout({ method: 'test-host', host })).toBe(60000);
  expect(runtimeCallTimeout({ method: 'request-ai-denial-review', taskId: 'fixture', operationId: 'op' })).toBe(650000);
  expect(runtimeCallTimeout({ method: 'connect', host })).toBe(180000);
});
it('allows manual consent and bounded startup within the outer RPC', () => {
  expect(runtimeCallTimeout({ method: 'open-terminal', hostId: host.id })).toBeGreaterThan(120000 + 30000);
});
it('contains explicit SSH and proxy deadlines while respecting proxy-over-jump routing', () => {
  const configured = { ...host, connection: { version: 1 as const, timeoutMs: 300000 } };
  expect(runtimeCallTimeout({ method: 'connect', host: configured })).toBe(330000);
  expect(runtimeCallTimeout({ method: 'connect', host: configured, jump: configured })).toBe(630000);
  const proxied = { ...configured, connection: { ...configured.connection, proxy: { enabled: true, protocol: 'http' as const, address: '127.0.0.1', port: 8080 } } };
  expect(runtimeCallTimeout({ method: 'connect', host: proxied })).toBe(630000);
  expect(runtimeCallTimeout({ method: 'connect', host: proxied, jump: configured })).toBe(630000);
});
it.each([NaN, Infinity, -1, 300001])('keeps invalid persisted timeouts bounded (%s)', (timeoutMs) => {
  const invalid = { ...host, connection: { version: 1 as const, timeoutMs } };
  expect(runtimeCallTimeout({ method: 'connect', host: invalid })).toBe(180000);
});
