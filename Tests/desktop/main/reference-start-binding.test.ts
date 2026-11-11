import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { StructuredSend } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
import { registerConversationIpc } from '../../../apps/desktop/src/main/conversation-ipc.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) } }));
const resources: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); ipc.handlers.clear(); for (const close of resources.splice(0).reverse()) close(); });
function setup(failRuntime = false) {
  const store = new SqliteStore(':memory:'); const state = new AppState(store, () => {});
  resources.push(() => { state.close(); store.close(); });
  vi.spyOn(state, 'runtimeProfile').mockReturnValue({ provider: 'cloudhelm-custom', modelId: 'fixture', apiKey: 'synthetic', baseUrl: 'https://models.example.invalid/v1', contextWindow: 10000, maxTokens: 512 });
  const boundBeforeDispatch: string[] = [], bodyIds: string[] = [];
  const call = vi.fn(async (request: RuntimeCall) => {
    if (request.method === 'prepare-message') {
      bodyIds.push(...request.bodies.map((body) => body.reference.id));
      return { text: 'synthetic prepared message', document: request.document, bodies: request.bodies };
    }
    if (request.method === 'start-task') {
      expect(store.get('message-receipts', 'request')).toMatchObject({ state: 'dispatching', conversationId: request.task.id });
      for (const id of bodyIds) expect(store.readReference(id)).toBeDefined();
      boundBeforeDispatch.push(request.task.id);
      if (failRuntime) throw new Error('runtime stopped');
      return;
    }
    throw new Error('Unexpected runtime request');
  });
  registerConversationIpc({ store, state, references: new ReferenceStore(store, state), sessionRoot: 'synthetic-unused-root',
    runtime: { call } as unknown as RuntimeBridge, connectHost: async () => { throw new Error('SSH must not be used'); },
    takeSelections: () => [], restoreSelections() {} });
  const input: StructuredSend = { hostId: null, localSelectionTokens: [], document: { requestId: 'request', parts: [
    { type: 'reference', reference: { id: 'paste', kind: 'paste', capturedAt: 1 }, content: 'synthetic body' }
  ] } };
  return { store, state, call, boundBeforeDispatch, bodyIds,
    send: async () => ipc.handlers.get('cloudhelm:send-structured')!({}, input) };
}

describe('E02: real conversation assembly binds copies before runtime', () => {
  it.each([false, true])('retains a created owner even when the runtime response fails: %s', async (failure) => {
    const f = setup(failure);
    if (failure) await expect(f.send()).rejects.toThrow('runtime stopped'); else await f.send();
    expect(f.boundBeforeDispatch).toHaveLength(1);
    for (const id of f.bodyIds) expect(f.store.readReference(id)).toBeDefined();
    f.state.deleteTask(f.boundBeforeDispatch[0]!);
    for (const id of f.bodyIds) expect(f.store.readReference(id)).toBeUndefined();
  });
  it('blocks start-task when persisting ownership fails, and deletion uses the known receipt owner', async () => {
    const f = setup();
    vi.spyOn(f.store, 'bindReferencePreparation').mockImplementation(() => { throw new Error('synthetic binding failure'); });
    await expect(f.send()).rejects.toThrow('synthetic binding failure');
    expect(f.call.mock.calls.map(([request]) => request.method)).toEqual(['prepare-message']);
    const owner = f.store.get<{ conversationId: string }>('message-receipts', 'request')!.conversationId;
    expect(owner).toBeTruthy(); f.state.deleteTask(owner);
    for (const id of f.bodyIds) expect(f.store.readReference(id)).toBeUndefined();
  });
});
