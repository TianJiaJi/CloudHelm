import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { StructuredSend, TaskView, ReferenceBody } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import { registerStructuredMessageIpc } from '../../../apps/desktop/src/main/structured-message-ipc.js';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import type { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) } }));
let store: SqliteStore;
beforeEach(() => { ipc.handlers.clear(); store = new SqliteStore(':memory:'); });
afterEach(() => store.close());
const invoke = async (method: string, input: unknown) => await ipc.handlers.get(`cloudhelm:${method}`)!({}, input);
function setup() {
  const profile = { provider: 'test', modelId: 'test-model', apiKey: 'private-test-key' };
  const bodies = new Map<string, ReferenceBody>();
  const task = { id: 'task', hostIds: ['host'] } as TaskView;
  let budgetActive: (id: string, taskId?: string) => boolean = () => false;
  const inputBudget = vi.fn(); const execution = { model: 'idle', remote: 'idle', stopping: false, canStop: false };
  const state = { requestBudgets: { input: inputBudget },
    setBudgetPreparationAuthority: (active: (id: string, taskId?: string) => boolean) => { budgetActive = active; },
    getTask: () => task, getHost: () => ({ id: 'host', policyRevision: 1, status: 'connected' }), runtimeProfile: () => profile, conversationProfile: () => profile,
    runtimeReviewerForLiveTask: () => ({ selection: { kind: 'current' }, revision: 1 }),
    snapshot: () => ({ contextUsage: {}, messages: [], execution: { task: execution } }) } as unknown as AppState;
  const call = vi.fn(async (request: RuntimeCall) => {
    if (request.method === 'prepare-message') return { preparedContext: { beforeRevision: 'before', revision: 'after' }, document: request.document, bodies: request.bodies,
      text: request.document.parts.map((part) => part.type === 'text' ? part.text : request.bodies.find((body) => body.reference.id === part.reference.id)?.original).join('') };
    return undefined;
  });
  const send = vi.fn(async () => {}); const start = vi.fn<Parameters<typeof registerStructuredMessageIpc>[0]['start']>(async () => task);
  const references = { read: (id: string) => { const body = bodies.get(id); if (!body) throw new Error('missing'); return body; },
    save: (body: ReferenceBody) => bodies.set(body.reference.id, body), quote: vi.fn() } as unknown as ReferenceStore;
  registerStructuredMessageIpc({ state, store, runtime: { call } as unknown as RuntimeBridge, references, send, start });
  const input: StructuredSend = { conversationId: 'task', hostId: 'host', localSelectionTokens: [], document: { requestId: 'request-1',
    parts: [{ type: 'text', text: 'explain ' }, { type: 'reference', reference: { id: 'local', kind: 'paste', capturedAt: 1 }, content: 'password=secret\nhello' }] } };
  return { input, send, start, call, bodies, profile, inputBudget, execution, budgetActive: (id: string, taskId?: string) => budgetActive(id, taskId) };
}
describe('structured message IPC', () => {
  it('revokes auxiliary attempts when the selected model changes during preparation', async () => {
    const f = setup(); let finish!: () => void;
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (request) => {
      if (request.method === 'prepare-message') await new Promise<void>((resolve) => { finish = resolve; });
      return original(request);
    });
    const pending = invoke('send-structured', f.input);
    expect(f.budgetActive('request-1')).toBe(true);
    expect(f.budgetActive('request-1', 'task')).toBe(true);
    expect(f.budgetActive('request-1', 'foreign')).toBe(false);
    expect(f.inputBudget).toHaveBeenCalledExactlyOnceWith('task', 'request-1');
    f.profile.modelId = 'changed-model';
    expect(f.budgetActive('request-1')).toBe(false);
    finish(); await expect(pending).rejects.toThrow('模型已变化');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent and later retries and strips raw bodies from display metadata', async () => {
    const f = setup();
    await Promise.all([invoke('send-structured', f.input), invoke('send-structured', f.input)]);
    await invoke('send-structured', f.input);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.inputBudget).toHaveBeenCalledExactlyOnceWith('task', 'request-1');
    const preparation = f.call.mock.calls[0]![0];
    expect(preparation.method).toBe('prepare-message');
    if (preparation.method !== 'prepare-message') return;
    expect(preparation.bodies[0]?.original).not.toContain('secret');
    expect(JSON.stringify(preparation.document)).not.toContain('hello');
    await expect(invoke('send-structured', { ...f.input, hostId: 'different' })).rejects.toThrow('绑定其他内容');
  });
  it('forwards only the worker-issued version and rejects a missing preparation acknowledgment', async () => {
    const f = setup(); await invoke('send-structured', f.input);
    expect(f.send).toHaveBeenCalledWith('task', expect.any(String), [], expect.any(Object), undefined, { beforeRevision: 'before', revision: 'after' });
    f.call.mockImplementation(async () => undefined);
    const input = { ...f.input, document: { ...f.input.document, requestId: 'request-2' } };
    await expect(invoke('send-structured', input)).rejects.toThrow('准备版本确认不可用'); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('rechecks a new conversation binding after asynchronous host connection, before task creation', async () => {
    const f = setup(); f.input.conversationId = undefined;
    f.start.mockImplementation(async (_input, _doc, _text, _intent, assertPrepared) => {
      f.profile.modelId = 'changed-during-connection';
      assertPrepared?.([]);
      throw new Error('Must not create a task with an outdated preparation');
    });
    await expect(invoke('send-structured', f.input)).rejects.toThrow('准备绑定已变化');
    expect(f.send).not.toHaveBeenCalled(); expect(f.inputBudget).not.toHaveBeenCalled();
  });
  it('does not open competing preparation jobs for one conversation', async () => {
    const f = setup(); let finish!: () => void;
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (request) => {
      if (request.method === 'prepare-message') await new Promise<void>((resolve) => { finish = resolve; });
      return original(request);
    });
    const pending = invoke('send-structured', f.input);
    await expect(invoke('send-structured', { ...f.input, document: { ...f.input.document, requestId: 'request-2' } })).rejects.toThrow('已有消息');
    expect(f.inputBudget).toHaveBeenCalledTimes(1); finish(); await pending;
  });
  it('rejects foreign-host references even if the renderer changes their visible metadata', async () => {
    const f = setup(); const reference = { id: 'remote', kind: 'terminal' as const, hostId: 'foreign', capturedAt: 1 };
    f.bodies.set('remote', { reference, original: 'output' });
    f.input.document.parts = [{ type: 'reference', reference: { ...reference, hostId: 'host' } }];
    await expect(invoke('send-structured', f.input)).rejects.toThrow('目标主机'); expect(f.send).not.toHaveBeenCalled();
  });
  it('cancels preparation without dispatching a partial message and allows explicit retry', async () => {
    const f = setup(); let finish!: () => void;
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (request) => {
      if (request.method === 'prepare-message') await new Promise<void>((resolve) => { finish = resolve; });
      return original(request);
    });
    const pending = invoke('send-structured', f.input);
    expect(f.budgetActive('request-1')).toBe(true);
    expect(f.budgetActive('foreign')).toBe(false);
    await invoke('cancel-message', 'request-1');
    expect(f.budgetActive('request-1')).toBe(false);
    finish();
    await expect(pending).rejects.toThrow('已取消'); expect(f.send).not.toHaveBeenCalled();
    f.call.mockImplementation(original); await invoke('send-structured', f.input); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.budgetActive('request-1')).toBe(false);
  });
});
