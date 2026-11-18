import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { HostCapabilityProfile, HostView } from '@cloudhelm/contracts';
import { SqliteStore } from '@cloudhelm/adapters';
import { persistHostCapability } from '../../../apps/desktop/src/main/host-capability-record.js';

const host: HostView = { id: 'host', label: 'test', address: '192.0.2.1', port: 22, username: 'tester',
  auth: 'password', fingerprint: 'SHA256:trusted-key', status: 'connected', protectedPaths: [],
  defaultMode: 'ask', policyRevision: 1 };
function profile(): HostCapabilityProfile {
  return { version: 1, hostId: 'host', hostFingerprint: 'SHA256:trusted-key', loginAs: 'tester',
    connectionId: '11111111-1111-4111-8111-111111111111:1', observedAt: Date.now(),
    data: { os: 'Linux', distribution: 'alpine', version: '3.20', architecture: 'x86_64',
      architectureFamily: 'x86_64', kernel: '6.6', username: 'tester', uid: 1000,
      loginDirectory: '/home/tester', path: '/usr/bin:/bin', toolPresence: { sh: true, python3: false }, source: 'shell' } };
}

it('persists bounded host facts over migration 15 and reopens without granting authority', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudhelm-capability-'));
  const filename = path.join(directory, 'state.db');
  try {
    const store = new SqliteStore(filename);
    const observed = profile(); persistHostCapability(store, host, observed);
    expect(store.getHostCapability(host.id)).toEqual(observed);
    store.close();
    const reopened = new SqliteStore(filename);
    try { expect(reopened.getHostCapability(host.id)).toEqual(observed); }
    finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('rejects a different host key, identity, excess fields, and secret-like metadata', () => {
  const store = new SqliteStore(':memory:');
  try {
    for (const value of [
      { ...profile(), hostFingerprint: 'SHA256:changed' },
      { ...profile(), loginAs: 'root' },
      { ...profile(), data: { ...profile().data, os: 'password=synthetic' } },
      { ...profile(), data: { ...profile().data, unexpected: 'token' } }
    ]) expect(() => persistHostCapability(store, host, value)).toThrow();
    expect(store.getHostCapability(host.id)).toBeUndefined();
  } finally { store.close(); }
});
