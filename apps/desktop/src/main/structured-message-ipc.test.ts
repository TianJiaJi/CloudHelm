import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { StructuredSend, TaskView, ReferenceBody } from '@cloudhelm/contracts';
import type { RuntimeCall } from '@cloudhelm/contracts/runtime';
import { registerStructuredMessageIpc } from './structured-message-ipc.js';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import type { ReferenceStore } from './reference-store.js';
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
  const state = { getTask: () => task, runtimeProfile: () => profile, conversationProfile: () => profile,
    snapshot: () => ({ contextUsage: {}, messages: [] }) } as unknown as AppState;
  const call = vi.fn(async (request: RuntimeCall) => {
    if (request.method === 'prepare-message') return { document: request.document, bodies: request.bodies,
      text: request.document.parts.map((part) => part.type === 'text' ? part.text : request.bodies.find((body) => body.reference.id === part.reference.id)?.original).join('') };
    return undefined;
  });
  const send = vi.fn(async () => {}); const start = vi.fn(async () => task);
  const references = { read: (id: string) => { const body = bodies.get(id); if (!body) throw new Error('missing'); return body; },
    save: (body: ReferenceBody) => bodies.set(body.reference.id, body), quote: vi.fn() } as unknown as ReferenceStore;
  registerStructuredMessageIpc({ state, store, runtime: { call } as unknown as RuntimeBridge, references, send, start });
  const input: StructuredSend = { conversationId: 'task', hostId: 'host', localSelectionTokens: [], document: { requestId: 'request-1',
    parts: [{ type: 'text', text: 'explain ' }, { type: 'reference', reference: { id: 'local', kind: 'paste', capturedAt: 1 }, content: 'password=secret\nhello' }] } };
  return { input, send, start, call, bodies };
}
describe('structured message IPC', () => {
  it('deduplicates concurrent and later retries and strips raw bodies from display metadata', async () => {
    const f = setup();
    await Promise.all([invoke('send-structured', f.input), invoke('send-structured', f.input)]);
    await invoke('send-structured', f.input);
    expect(f.send).toHaveBeenCalledTimes(1);
    const preparation = f.call.mock.calls[0]![0];
    expect(preparation.method).toBe('prepare-message');
    if (preparation.method !== 'prepare-message') return;
    expect(preparation.bodies[0]?.original).not.toContain('secret');
    expect(JSON.stringify(preparation.document)).not.toContain('hello');
    await expect(invoke('send-structured', { ...f.input, hostId: 'different' })).rejects.toThrow('绑定其他内容');
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
    await invoke('cancel-message', 'request-1'); finish();
    await expect(pending).rejects.toThrow('已取消'); expect(f.send).not.toHaveBeenCalled();
    f.call.mockImplementation(original); await invoke('send-structured', f.input); expect(f.send).toHaveBeenCalledTimes(1);
  });
});
