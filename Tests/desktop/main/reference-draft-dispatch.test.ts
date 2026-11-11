import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { MessageDocument, ReferenceBody, StructuredSend, TaskView } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
import { registerStructuredMessageIpc } from '../../../apps/desktop/src/main/structured-message-ipc.js';
import { DraftSender } from './reference-draft-fixture.js';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) } }));
let store: SqliteStore;
beforeEach(() => { ipc.handlers.clear(); store = new SqliteStore(':memory:'); store.beginReferenceSession('boot'); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function setup(existing = true) {
  const sender = new DraftSender(), task = { id: 'task', hostIds: ['host'] } as TaskView;
  store.put('hosts', 'host', { id: 'host' }); store.put('tasks', task.id, task);
  const profile = { provider: 'synthetic', modelId: 'fixture' };
  let authority!: (id: string, taskId?: string) => boolean;
  const state = { requestBudgets: { input() {} }, setBudgetPreparationAuthority: (value: typeof authority) => { authority = value; },
    getTask: (id: string) => { const value = store.get<TaskView>('tasks', id); if (!value) throw new Error('Task not found'); return value; },
    getHost: () => ({ id: 'host', label: 'Synthetic host' }), runtimeProfile: () => profile, conversationProfile: () => profile,
    runtimeReviewerForLiveTask: () => ({ revision: 1 }), snapshot: () => ({ messages: [], execution: {}, terminals: [{ id: 'terminal', hostId: 'host' }] }) } as unknown as AppState;
  const preparing = deferred(), delivering = deferred();
  let cloned: ReferenceBody[] = [];
  const call = vi.fn(async (request: RuntimeCall) => {
    if (request.method !== 'prepare-message') return undefined;
    cloned = request.bodies;
    await preparing.promise;
    return { text: 'synthetic prepared message', document: request.document, bodies: request.bodies, preparedContext: { beforeRevision: 'before', revision: 'after' } };
  });
  const send = vi.fn(async () => delivering.promise);
  const start = vi.fn<Parameters<typeof registerStructuredMessageIpc>[0]['start']>(async (_input, _document, _text, _intent, validate, created) => {
    created?.(task.id); await delivering.promise; validate?.([]); return task;
  });
  registerStructuredMessageIpc({ state, store, references: new ReferenceStore(store, state), runtime: { call } as unknown as RuntimeBridge, send, start });
  const invoke = (name: string, ...args: unknown[]) => ipc.handlers.get(`cloudhelm:${name}`)!(sender.event(), ...args);
  const scope = { hostId: 'host', conversationId: existing ? 'task' : undefined };
  const draftId = invoke('open-reference-draft', scope) as string;
  const reference = invoke('quote-terminal', { ...scope, draftId, terminalId: 'terminal', selection: 'synthetic original' }) as ReferenceBody['reference'];
  const document: MessageDocument = { requestId: 'request', parts: [{ type: 'reference', reference }] };
  const input: StructuredSend = { ...scope, draftId, document, localSelectionTokens: [] };
  return { sender, call, send, start, preparing, delivering, reference, invoke, input,
    authorized: () => authority('request'), copies: () => cloned.map((body) => body.reference.id) };
}

it('revokes preparing authority synchronously on renderer loss and refuses a late preparation result', async () => {
  const f = setup(); const pending = f.invoke('send-structured', f.input) as Promise<unknown>;
  const rejected = expect(pending).rejects.toThrow('已取消发送');
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledWith(expect.objectContaining({ method: 'prepare-message' })));
  expect(f.authorized()).toBe(true); f.sender.emit('render-process-gone'); expect(f.authorized()).toBe(false);
  expect(store.readReference(f.reference.id)).toBeUndefined();
  f.preparing.resolve(); await rejected; expect(f.send).not.toHaveBeenCalled();
  for (const id of f.copies()) expect(store.readReference(id)).toBeUndefined();
});

it.each([true, false])('preserves committed copies and delivery after source release (existing=%s)', async (existing) => {
  const f = setup(existing); const pending = f.invoke('send-structured', f.input) as Promise<unknown>;
  f.preparing.resolve(); await vi.waitFor(() => expect(existing ? f.send : f.start).toHaveBeenCalledOnce());
  f.invoke('release-reference-draft', f.input.draftId);
  expect(store.readReference(f.reference.id)).toBeUndefined();
  for (const id of f.copies()) expect(store.readReference(id)).toBeDefined();
  expect(f.call.mock.calls.filter(([request]) => request.method === 'cancel-message')).toHaveLength(0);
  f.delivering.resolve(); await expect(pending).resolves.toEqual({ conversationId: 'task' });
  store.commitConversationDeletion('task', [], []);
  for (const id of f.copies()) expect(store.readReference(id)).toBeUndefined();
});
