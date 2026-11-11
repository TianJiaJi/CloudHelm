import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, TaskView, ThinkingLevel } from '@cloudhelm/contracts';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { thinkingForRestore } from '../../../apps/desktop/src/main/conversation-thinking.js';

const vault = vi.hoisted(() => ({ decrypt: vi.fn(() => { throw new Error('Credential access is forbidden'); }) }));
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false, decryptString: vault.decrypt } }));
const resources: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vault.decrypt.mockClear(); for (const close of resources.splice(0).reverse()) close(); });
function setup() {
  const store = new SqliteStore(':memory:'); const events: AppEvent[] = [];
  const state = new AppState(store, (event) => events.push(event));
  resources.push(() => { state.close(); store.close(); });
  const task = state.createTask('Synthetic preference', [], 'deepseek-flash', []);
  state.setTaskModel(task.id, { provider: 'deepseek', modelId: 'deepseek-flash', apiKey: 'synthetic-not-used' });
  events.length = 0;
  return { state, store, task, events, preferences: state.thinkingPreferences };
}
const observed = (selected: ThinkingLevel, effective = selected) => ({ levels: ['off', 'low', 'high', 'max'] as ThinkingLevel[],
  selected, effective, pending: selected !== effective });

describe('F02: durable local thinking preference', () => {
  it('persists with unavailable credentials without changing task/budget state', () => {
    const f = setup(), budget = structuredClone(f.task.budget);
    f.preferences.set(f.task.id, 'high');
    expect(f.store.get<TaskView>('tasks', f.task.id)).toMatchObject({ preferredThinking: 'high', status: 'draft', budget,
      thinking: { selected: 'high', effective: 'off', pending: true } });
    expect(vault.decrypt).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type === 'snapshot')).toHaveLength(1);
    expect(f.store.list('model-requests')).toEqual([]);
    const restarted = new AppState(f.store, () => {});
    try {
      expect(thinkingForRestore(restarted.getTask(f.task.id))).toBe('high');
      expect(restarted.thinkingPreferences.pending(f.task.id)).toBe('high');
    } finally { restarted.close(); }
  });

  it('leaves memory and notifications unchanged if persistence fails', () => {
    const f = setup(), before = structuredClone(f.task);
    vi.spyOn(f.store, 'put').mockImplementationOnce(() => { throw new Error('synthetic persistence failure'); });
    expect(() => f.preferences.set(f.task.id, 'high')).toThrow('synthetic persistence failure');
    expect(f.state.getTask(f.task.id)).toEqual(before);
    expect(f.store.get('tasks', f.task.id)).toEqual(before); expect(f.events).toEqual([]);
  });

  it('retains the latest preference when an older runtime observation arrives', () => {
    const f = setup(); f.preferences.set(f.task.id, 'low'); f.preferences.set(f.task.id, 'max');
    f.state.record({ type: 'thinking', taskId: f.task.id, value: observed('low') });
    expect(f.task.thinking).toMatchObject({ selected: 'max', effective: 'low', pending: true });
    expect(f.preferences.pending(f.task.id)).toBe('max');
    f.state.record({ type: 'thinking', taskId: f.task.id, value: observed('max') });
    expect(f.task.thinking).toMatchObject({ selected: 'max', effective: 'max', pending: false });
    expect(f.preferences.pending(f.task.id)).toBeUndefined();
  });

  it('does not leave an already effective level permanently pending when selected again', () => {
    const f = setup(); f.preferences.set(f.task.id, 'high');
    f.state.record({ type: 'thinking', taskId: f.task.id, value: observed('high') });
    f.preferences.set(f.task.id, 'high');
    expect(f.preferences.pending(f.task.id)).toBeUndefined();
    expect(f.task.thinking).toMatchObject({ selected: 'high', effective: 'high', pending: false });
  });

  it.each(['off', 'high'] as const)('retains a genuine runtime pending state when effective level is %s', (effective) => {
    const f = setup(); f.preferences.set(f.task.id, 'high');
    f.state.record({ type: 'thinking', taskId: f.task.id, value: { ...observed('high', effective), pending: true } });
    f.preferences.set(f.task.id, 'high');
    expect(f.task.thinking?.pending).toBe(true);
    expect(f.preferences.pending(f.task.id)).toBeUndefined();
  });

  it('does not repeatedly invalidate preparation when runtime already selected the pending streaming level', () => {
    const f = setup(); f.preferences.set(f.task.id, 'high');
    f.state.record({ type: 'thinking', taskId: f.task.id, value: observed('high', 'off') });
    expect(f.task.thinking?.pending).toBe(true);
    expect(f.preferences.pending(f.task.id)).toBeUndefined();
    f.state.runtimeStopped(); expect(f.preferences.pending(f.task.id)).toBe('high');
  });

  it.each(['medium', 'unknown', null, 1])('rejects unsupported or malformed level %s without writes', (level) => {
    const f = setup(), before = structuredClone(f.task);
    expect(() => f.preferences.set(f.task.id, level as ThinkingLevel)).toThrow('不支持');
    expect(f.task).toEqual(before); expect(f.events).toEqual([]);
  });

  it('clamps an explicit preference on model change without sending off to a non-reasoning model', () => {
    const f = setup(); f.preferences.set(f.task.id, 'max');
    f.state.setTaskModel(f.task.id, { provider: 'cloudhelm-custom', modelId: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' });
    expect(f.task.preferredThinking).toBe('off');
    expect(thinkingForRestore(f.task)).toBeUndefined(); expect(f.preferences.pending(f.task.id)).toBeUndefined();
  });

  it('keeps model metadata intact when its persistence fails', () => {
    const f = setup(), before = structuredClone(f.task);
    vi.spyOn(f.store, 'put').mockImplementationOnce(() => { throw new Error('synthetic persistence failure'); });
    expect(() => f.state.setTaskModel(f.task.id, { provider: 'cloudhelm-custom', modelId: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' })).toThrow('synthetic persistence failure');
    expect(f.task).toEqual(before); expect(f.events).toEqual([]);
  });
});
