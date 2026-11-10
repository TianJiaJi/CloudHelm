import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ModelProfileDraft } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';

// Synthetic encryption only: exercises persistence/ownership, not OS keychain availability.
const vault = vi.hoisted(() => ({ available: true, decrypt: vi.fn((bytes: Buffer) => {
  const value = bytes.toString().slice('sealed:'.length);
  if (value === 'damaged-fixture') throw new Error('native failure containing synthetic-sensitive-detail');
  return value;
}) }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => vault.available,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`),
  decryptString: vault.decrypt
} }));
const resources: Array<() => void> = [];
const profile = (change: Partial<ModelProfileDraft> = {}): ModelProfileDraft => ({ provider: 'cloudhelm-custom',
  modelId: 'fixture-model', baseUrl: 'http://localhost:1234/v1', apiKey: 'synthetic-account-a', ...change });
const sealed = (value: string) => Buffer.from(`sealed:${value}`).toString('base64');
function setup() {
  const store = new SqliteStore(':memory:');
  const events: AppEvent[] = [];
  const state = new AppState(store, (event) => events.push(event));
  resources.push(() => { state.close(); store.close(); });
  return { state, store, events };
}
beforeEach(() => { vault.available = true; vault.decrypt.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) close(); });

describe('F01: projection does not exercise credential capabilities', () => {
  it.each([false, true])('loads settings and publishes repeatedly without decrypting when encryption availability=%s', (available) => {
    const { state, store, events } = setup();
    state.saveProfile(profile());
    store.put('secrets', 'model-key:cloudhelm-custom', sealed('damaged-fixture'));
    store.put('secrets', 'jev-key:vercel-ai-gateway', sealed('damaged-fixture'));
    vault.available = available; vault.decrypt.mockClear();
    const restored = new AppState(store, (event) => events.push(event));
    try {
      for (let index = 0; index < 100; index++) restored.publish();
      expect(restored.snapshot().profile).toMatchObject({ hasKey: true, hasJevKey: true });
      expect(restored.modelProviderSettings('cloudhelm-custom')).toMatchObject({ hasKey: true });
      expect(restored.availableModels()).toContainEqual(expect.objectContaining({ modelId: 'fixture-model' }));
      expect(vault.decrypt).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain('damaged-fixture');
      expect(() => restored.runtimeProfile()).toThrow('OS credential decryption is unavailable');
    } finally { restored.close(); }
  });

  it('checks legacy presence without moving credentials or decoding unrelated providers', () => {
    const { state, store } = setup();
    state.saveProfile(profile());
    store.remove('secrets', 'model-key:cloudhelm-custom');
    store.put('secrets', 'model-key:cloudhelm-custom:fixture-model:http://localhost:1234/v1', sealed('damaged-fixture'));
    vault.available = false; vault.decrypt.mockClear();
    expect(state.snapshot().profile.hasKey).toBe(true);
    expect(state.modelProviderSettings('cloudhelm-custom').hasKey).toBe(true);
    expect(state.modelProviderSettings('deepseek').hasKey).toBe(false);
    expect(store.get('secrets', 'model-key:cloudhelm-custom')).toBeUndefined();
    expect(vault.decrypt).not.toHaveBeenCalled();
  });

  it('allows explicit replacement of a damaged credential, never silently reusing it', () => {
    const { state, store } = setup(); state.saveProfile(profile());
    const revision = state.runtimeProfile().credentialRevision;
    store.put('secrets', 'model-key:cloudhelm-custom', sealed('damaged-fixture'));
    expect(() => state.saveProfile(profile({ apiKey: undefined }))).toThrow('OS credential decryption is unavailable');
    state.saveProfile(profile({ apiKey: 'synthetic-repaired-account' }));
    expect(state.runtimeProfile().apiKey).toBe('synthetic-repaired-account');
    expect(state.runtimeProfile().credentialRevision).not.toBe(revision);
  });

  it('does not expose native decryption error details in runtime errors', () => {
    const { state, store } = setup(); state.saveProfile(profile());
    store.put('secrets', 'model-key:cloudhelm-custom', sealed('damaged-fixture'));
    expect(() => state.runtimeProfile()).toThrow('OS credential decryption is unavailable');
    try { state.runtimeProfile(); } catch (error) { expect(String(error)).not.toContain('synthetic-sensitive-detail'); }
  });
});

describe('A02: settings and encrypted credentials commit atomically', () => {
  it.each(['model-profile', 'model-provider:cloudhelm-custom', 'model-key:cloudhelm-custom'])(
    'rolls back database, memory and publication if writing %s fails', (failedId) => {
      const { state, store, events } = setup(); state.saveProfile(profile());
      const before = state.runtimeProfile(), snapshot = state.snapshot();
      const settings = store.list('settings'), secrets = store.list('secrets'); events.length = 0;
      const put = store.put.bind(store);
      const failure = vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
        if (id === failedId) throw new Error('synthetic persistence failure');
        put(bucket, id, value);
      });
      expect(() => state.saveProfile(profile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'synthetic-account-b' })))
        .toThrow('synthetic persistence failure');
      failure.mockRestore();
      expect(store.list('settings')).toEqual(settings); expect(store.list('secrets')).toEqual(secrets);
      expect(state.runtimeProfile()).toEqual(before); expect(state.snapshot()).toEqual(snapshot); expect(events).toEqual([]);
      const restored = new AppState(store, () => {});
      try { expect(restored.runtimeProfile()).toEqual(before); } finally { restored.close(); }
    });

  it('commits a new endpoint, credential and revision together and publishes only once', () => {
    const { state, store, events } = setup(); state.saveProfile(profile());
    const before = state.runtimeProfile(); events.length = 0;
    state.saveProfile(profile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'synthetic-account-b' }));
    expect(state.runtimeProfile()).toMatchObject({ baseUrl: 'http://localhost:4321/v1', apiKey: 'synthetic-account-b' });
    expect(state.runtimeProfile().credentialRevision).not.toBe(before.credentialRevision);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(store.list('settings'))).not.toContain('synthetic-account-b');
    expect(JSON.stringify(events)).not.toContain('synthetic-account-b');
  });

  it.each(['save', 'remove'] as const)('does not partially %s a reviewer key on persistence failure', (action) => {
    const { state, store, events } = setup(); state.saveProfile(profile());
    state.saveReviewSettings({ jevKey: 'synthetic-review-a', reviewer: { kind: 'current' } });
    const settings = store.list('settings'), secrets = store.list('secrets'); events.length = 0;
    const put = store.put.bind(store), remove = store.remove.bind(store);
    if (action === 'save') vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
      if (id === 'reviewer') throw new Error('synthetic persistence failure');
      put(bucket, id, value);
    });
    else vi.spyOn(store, 'remove').mockImplementation((bucket, id) => {
      if (id === 'jev-key:vercel-ai-gateway') throw new Error('synthetic persistence failure');
      remove(bucket, id);
    });
    expect(() => state.saveReviewSettings(action === 'save'
      ? { jevKey: 'synthetic-review-b', reviewer: { kind: 'jev' } }
      : { disableJev: true, reviewer: { kind: 'current' } })).toThrow('synthetic persistence failure');
    vi.restoreAllMocks();
    expect(store.list('settings')).toEqual(settings); expect(store.list('secrets')).toEqual(secrets);
    expect(state.reviewKey()).toBe('synthetic-review-a'); expect(events).toEqual([]);
  });

  it('publishes one coherent reviewer selection and key state', () => {
    const { state, events } = setup(); state.saveProfile(profile()); events.length = 0;
    state.saveReviewSettings({ jevKey: 'synthetic-review-a', reviewer: { kind: 'jev' } });
    expect(events).toHaveLength(1);
    expect(state.snapshot().profile).toMatchObject({ hasJevKey: true, reviewer: { kind: 'jev' } });
    events.length = 0;
    state.saveReviewSettings({ disableJev: true, reviewer: { kind: 'current' } });
    expect(events).toHaveLength(1);
    expect(state.snapshot().profile).toMatchObject({ hasJevKey: false, reviewer: { kind: 'current' } });
  });
});
