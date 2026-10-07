import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ModelProfileDraft, TaskView } from '@cloudhelm/contracts';
import { AppState } from './app-state.js';

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
} }));

class MemoryStore {
  private readonly buckets = new Map<string, Map<string, unknown>>();
  get<T>(bucket: string, id: string): T | undefined {
    return structuredClone(this.buckets.get(bucket)?.get(id)) as T | undefined;
  }
  list<T>(bucket: string): T[] { return [...(this.buckets.get(bucket)?.values() ?? [])].map((value) => structuredClone(value) as T); }
  put(bucket: string, id: string, value: unknown): void {
    const values = this.buckets.get(bucket) ?? new Map<string, unknown>();
    values.set(id, structuredClone(value)); this.buckets.set(bucket, values);
  }
  remove(bucket: string, id: string): void { this.buckets.get(bucket)?.delete(id); }
  cleanupLogs(): void {}
  appendLog(): void {}
}

const openStates: AppState[] = [];
function setup(store = new MemoryStore()) {
  const events: AppEvent[] = [];
  const state = new AppState(store as unknown as SqliteStore, (event) => events.push(event));
  openStates.push(state);
  return { state, store, events };
}
const customProfile = (update: Partial<ModelProfileDraft> = {}): ModelProfileDraft => ({
  provider: 'cloudhelm-custom', modelId: 'model-one', baseUrl: 'http://localhost:1234/v1', apiKey: 'key-for-endpoint-one', ...update
});
function conversation(state: AppState): TaskView {
  const profile = state.runtimeProfile();
  const task = state.createTask('Explain container health checks', [], profile.modelId, []);
  state.setTaskModel(task.id, profile);
  return task;
}

afterEach(() => {
  encryption.available = true;
  for (const state of openStates.splice(0)) state.close();
});

describe('conversation credential binding', () => {
  it('keeps terminal replacement in authoritative snapshots after further terminal state events', () => {
    const { state, events } = setup();
    state.record({ type: 'terminal-state', terminalId: 'old', hostId: 'host', taskId: 'task', state: 'human' });
    state.record({ type: 'terminal-state', terminalId: 'new', hostId: 'host', taskId: 'task', state: 'agent' });
    state.record({ type: 'terminal-replaced', previousTerminalId: 'old', terminalId: 'new' });
    state.record({ type: 'terminal-state', terminalId: 'old', hostId: 'host', taskId: 'task', state: 'human' });
    expect(state.snapshot().terminals.find((item) => item.id === 'old')).toMatchObject({ state: 'human', replacementTerminalId: 'new' });
    expect(events).toContainEqual({ type: 'terminal-replaced', previousTerminalId: 'old', terminalId: 'new' });
  });
  it.each([
    { apiKey: 'replacement-account-key' },
    { baseUrl: 'http://localhost:4321/v1', apiKey: undefined },
    { baseUrl: 'http://localhost:4321/v1', apiKey: 'new-endpoint-key' }
  ])('requires explicit reselection after the provider credentials or endpoint change: %j', (update) => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const inFlightProfile = state.conversationProfile(task);
    state.saveProfile(customProfile(update));
    expect(state.runtimeProfile().credentialRevision).not.toBe(task.credentialRevision);
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    expect(inFlightProfile.apiKey).toBe('key-for-endpoint-one');
    expect(inFlightProfile.baseUrl).toBe('http://localhost:1234/v1');
    const restarted = setup(store).state;
    expect(() => restarted.conversationProfile(restarted.getTask(task.id))).toThrow('重新选择模型');
  });

  it('keeps the binding when only the default model changes or an identical key is saved', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile(customProfile({ modelId: 'model-two' }));
    expect(state.runtimeProfile().credentialRevision).toBe(task.credentialRevision);
    expect(state.conversationProfile(task).modelId).toBe('model-one');
    state.saveProfile(customProfile({ modelId: 'model-three', apiKey: undefined }));
    expect(state.conversationProfile(task).apiKey).toBe('key-for-endpoint-one');
    expect(state.runtimeProfile().credentialRevision).toBe(task.credentialRevision);
  });

  it('does not redirect an existing conversation when another provider becomes the global default', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile({ provider: 'openai', modelId: 'gpt-4.1', apiKey: 'other-provider-key' });
    expect(state.runtimeProfile().provider).toBe('openai');
    expect(state.conversationProfile(task)).toMatchObject({ provider: 'cloudhelm-custom', modelId: 'model-one',
      baseUrl: 'http://localhost:1234/v1', apiKey: 'key-for-endpoint-one', credentialRevision: task.credentialRevision });
  });

  it('allows recovery after explicit model reselection and records the new binding without plaintext keys', () => {
    const { state, store, events } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.saveProfile(customProfile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'replacement-account-key' }));
    const chosen = state.runtimeProfile({ provider: 'cloudhelm-custom', modelId: 'model-one' });
    state.setTaskModel(task.id, chosen);
    expect(state.conversationProfile(task)).toMatchObject({ baseUrl: 'http://localhost:4321/v1', apiKey: 'replacement-account-key' });
    expect(JSON.stringify(store.get('tasks', task.id))).not.toContain('replacement-account-key');
    expect(JSON.stringify(state.snapshot())).not.toContain('replacement-account-key');
    expect(JSON.stringify(events)).not.toContain('replacement-account-key');
    expect(store.get<string>('secrets', 'model-key:cloudhelm-custom')).not.toContain('replacement-account-key');
  });

  it('requires legacy conversations to select a model instead of inferring their old account', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    delete task.credentialRevision;
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
    state.runtimeProfile();
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
  });

  it('creates a revision for a legacy provider without silently binding old conversations', () => {
    const store = new MemoryStore();
    const legacy = { provider: 'cloudhelm-custom', modelId: 'model-one', baseUrl: 'http://localhost:1234/v1' };
    store.put('settings', 'model-profile', legacy);
    store.put('secrets', 'model-key:cloudhelm-custom', Buffer.from('encrypted:legacy-key').toString('base64'));
    const { state } = setup(store);
    const profile = state.runtimeProfile();
    expect(profile.credentialRevision).toEqual(expect.any(String));
    expect(profile.apiKey).toBe('legacy-key');
    expect(state.runtimeProfile().credentialRevision).toBe(profile.credentialRevision);
    const task = state.createTask('Old work', [], legacy.modelId, []);
    expect(() => state.conversationProfile(task)).toThrow('重新选择模型');
  });

  it('does not persist or rebind credentials when testing a settings draft', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    const before = store.get('settings', 'model-profile');
    const test = state.testProfile(customProfile({ baseUrl: 'http://localhost:4321/v1', apiKey: 'temporary-test-key' }));
    expect(test.apiKey).toBe('temporary-test-key');
    expect(test.baseUrl).toBe('http://localhost:4321/v1');
    expect(store.get('settings', 'model-profile')).toEqual(before);
    expect(state.conversationProfile(task).credentialRevision).toBe(task.credentialRevision);
  });

  it('does not replace saved defaults if OS encryption is unavailable for a new credential', () => {
    const { state, store } = setup();
    const original = state.snapshot().profile;
    encryption.available = false;
    expect(() => state.saveProfile(customProfile())).toThrow('encryption is unavailable');
    expect(state.snapshot().profile).toEqual(original);
    expect(store.get('settings', 'model-provider:cloudhelm-custom')).toBeUndefined();
  });
});

describe('state disposal', () => {
  it('flushes logs once and ignores late worker events after the database is closed', () => {
    vi.useFakeTimers();
    try {
      const { state, store, events } = setup();
      const append = vi.spyOn(store, 'appendLog');
      state.record({ type: 'terminal-data', terminalId: 'terminal', data: 'final output' });
      state.close();
      expect(append).toHaveBeenCalledOnce();
      const accesses = [vi.spyOn(store, 'get'), vi.spyOn(store, 'put'), vi.spyOn(store, 'cleanupLogs'), append];
      for (const access of accesses) {
        access.mockClear();
        access.mockImplementation(() => { throw new Error('The database connection is not open'); });
      }
      events.length = 0;
      expect(() => {
        state.record({ type: 'task-message', taskId: 'task', role: 'agent', text: 'late result', createdAt: 1 });
        state.record({ type: 'terminal-data', terminalId: 'terminal', data: 'late output' });
        state.runtimeStopped(); state.publish(); state.close();
        vi.advanceTimersByTime(24 * 60 * 60_000);
      }).not.toThrow();
      for (const access of accesses) expect(access).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});


describe('clarification persistence', () => {
  it('expires pending questions on restart while retaining answered questions and pausing the conversation', () => {
    const { state, store } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'task-status', taskId: task.id, status: 'waiting-user' });
    const request = { id: 'ask', taskId: task.id, toolCallId: 'tool', generation: 'run', questions: [{ id: 'q', prompt: '环境？' }], createdAt: 1, expiresAt: 9999999999999, status: 'pending' as const };
    state.record({ type: 'clarification', value: request });
    state.record({ type: 'clarification', value: { ...request, id: 'answered', status: 'answered', answers: [{ id: 'q', value: '测试', custom: true }] } });
    const restarted = setup(store).state;
    expect(restarted.getTask(task.id).status).toBe('paused');
    expect(restarted.snapshot().clarifications).toEqual([{ ...request, status: 'expired' }, { ...request, id: 'answered', status: 'answered', answers: [{ id: 'q', value: '测试', custom: true }] }]);
    expect(setup(store).state.snapshot().clarifications?.[0]?.status).toBe('expired');
  });
  it('expires questions when the utility process exits', () => {
    const { state } = setup();
    state.saveProfile(customProfile());
    const task = conversation(state);
    state.record({ type: 'task-status', taskId: task.id, status: 'waiting-user' });
    state.record({ type: 'clarification', value: { id: 'ask', taskId: task.id, toolCallId: 'tool', generation: 'run', questions: [{ id: 'q', prompt: '环境？' }], createdAt: 1, expiresAt: 9999999999999, status: 'pending' } });
    state.runtimeStopped();
    expect(state.getTask(task.id).status).toBe('paused');
    expect(state.snapshot().clarifications?.[0]?.status).toBe('expired');
  });
});

it('persists deliberate interruption metadata separately from observed process outcomes', () => {
  const { state, store } = setup();
  const interruption = { source: 'ctrl-c' as const, requestedAt: 10, operationIds: ['op'] };
  state.record({ type: 'task-message', taskId: 'task', role: 'system', text: '用户通过 Ctrl+C 主动终止执行。', interruption, createdAt: 10 });
  state.record({ type: 'operation', value: { id: 'op', taskId: 'task', hostId: 'host', kind: 'command', preview: 'sleep 30', status: 'failed', exitCode: 130, createdAt: 1, interruption } });
  const restored = setup(store).state.snapshot();
  expect(restored.messages[0]?.interruption).toEqual(interruption);
  expect(restored.operations[0]).toMatchObject({ status: 'failed', exitCode: 130, interruption });
});
