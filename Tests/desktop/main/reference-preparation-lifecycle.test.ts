import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceBody, StructuredSend, TaskView } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
import { registerStructuredMessageIpc } from '../../../apps/desktop/src/main/structured-message-ipc.js';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) } }));
let store: SqliteStore;
beforeEach(() => { ipc.handlers.clear(); store = new SqliteStore(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });
const invoke = async (input: StructuredSend) => ipc.handlers.get('cloudhelm:send-structured')!({}, input);
function setup() {
  const task = { id: 'task', hostIds: ['host'] } as TaskView;
  store.put('tasks', task.id, task);
  const profile = { provider: 'test', modelId: 'fixture', apiKey: 'synthetic-key' };
  const state = { requestBudgets: { input() {} }, setBudgetPreparationAuthority() {},
    getTask: (id: string) => { const value = store.get<TaskView>('tasks', id); if (!value) throw new Error('Task not found'); return value; },
    getHost: () => ({ id: 'host', label: 'Synthetic host' }), runtimeProfile: () => profile, conversationProfile: () => profile,
    runtimeReviewerForLiveTask: () => ({ revision: 1 }), snapshot: () => ({ messages: [], execution: {} }) } as unknown as AppState;
  const call = vi.fn(async (request: RuntimeCall) => request.method === 'prepare-message' ? {
    text: 'synthetic prepared text', document: request.document, bodies: request.bodies,
    preparedContext: { beforeRevision: 'before', revision: 'after' }
  } : undefined);
  const send = vi.fn(async () => {});
  const start = vi.fn<Parameters<typeof registerStructuredMessageIpc>[0]['start']>(async () => task);
  const writes = vi.spyOn(store, 'putReference');
  registerStructuredMessageIpc({ state, store, references: new ReferenceStore(store, state), runtime: { call } as unknown as RuntimeBridge, send, start });
  const input: StructuredSend = { conversationId: task.id, hostId: 'host', localSelectionTokens: [], document: {
    requestId: 'request', parts: [1, 2].map((id) => ({ type: 'reference' as const,
      reference: { id: `paste-${id}`, kind: 'paste' as const, capturedAt: 1 }, content: `synthetic body ${id}` }))
  } };
  const savedIds = () => writes.mock.calls.map(([id]) => id);
  return { input, call, send, start, writes, savedIds };
}

describe('E02: prepared reference ownership', () => {
  it('rolls back every body if a later reference write fails, before dispatch', async () => {
    const f = setup(); const put = SqliteStore.prototype.putReference.bind(store); let count = 0;
    f.writes.mockImplementation((id, value) => { put(id, value); if (++count === 2) throw new Error('synthetic body write failure'); });
    await expect(invoke(f.input)).rejects.toThrow('synthetic body write failure');
    expect(f.savedIds()).toHaveLength(2);
    for (const id of f.savedIds()) expect(store.readReference(id)).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(store.get('message-receipts', 'request')).toMatchObject({ state: 'failed' });
  });

  it('rolls back bodies when persisting the dispatch receipt fails', async () => {
    const f = setup(); const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((bucket, id, value) => {
      put(bucket, id, value);
      if (bucket === 'message-receipts' && (value as { state?: string }).state === 'dispatching') throw new Error('synthetic receipt failure');
    });
    await expect(invoke(f.input)).rejects.toThrow('synthetic receipt failure');
    expect(f.savedIds()).toHaveLength(2);
    for (const id of f.savedIds()) expect(store.readReference(id)).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps unknown delivery evidence until its owning conversation is deleted', async () => {
    const f = setup(); f.send.mockRejectedValue(new Error('runtime stopped'));
    await expect(invoke(f.input)).rejects.toThrow('runtime stopped');
    for (const id of f.savedIds()) expect(store.readReference<ReferenceBody>(id)?.original).toContain('synthetic body');
    store.commitConversationDeletion('task', [], []);
    for (const id of f.savedIds()) expect(store.readReference(id)).toBeUndefined();
  });

  it('reclaims copies when starting a conversation fails before any task is created', async () => {
    const f = setup(); f.input.conversationId = undefined;
    f.start.mockRejectedValue(new Error('synthetic connection failure'));
    await expect(invoke(f.input)).rejects.toThrow('synthetic connection failure');
    for (const id of f.savedIds()) expect(store.readReference(id)).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });
});
