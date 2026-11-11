import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceInfo } from '@cloudhelm/contracts';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import { ReferenceStore } from '../../../apps/desktop/src/main/reference-store.js';
import { registerReferenceDraftIpc } from '../../../apps/desktop/src/main/reference-draft-ipc.js';
import { DraftSender } from './reference-draft-fixture.js';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) } }));
let store: SqliteStore;
const revoke = vi.fn();
beforeEach(() => {
  ipc.handlers.clear(); revoke.mockReset(); store = new SqliteStore(':memory:'); store.beginReferenceSession('boot');
  store.put('hosts', 'host', { id: 'host' }); store.put('tasks', 'task', { id: 'task', hostIds: ['host'] });
  const state = { snapshot: () => ({ terminals: [{ id: 'terminal', hostId: 'host' }] }), getTask: () => ({ hostIds: ['host'] }), getHost: () => ({ label: 'Synthetic host' }) } as unknown as AppState;
  registerReferenceDraftIpc(store, new ReferenceStore(store, state), revoke, (id) => { if (id === 'deleting') throw new Error('conversation deleting'); });
});
afterEach(() => { vi.restoreAllMocks(); store.close(); });
const invoke = (name: string, sender: DraftSender, ...args: unknown[]) => ipc.handlers.get(`cloudhelm:${name}`)!(sender.event(), ...args);
const open = (sender: DraftSender) => invoke('open-reference-draft', sender, { hostId: 'host', conversationId: 'task' }) as string;
const quote = (sender: DraftSender, draftId: string) => invoke('quote-terminal', sender, { draftId, terminalId: 'terminal', hostId: 'host', conversationId: 'task', selection: 'synthetic evidence' }) as ReferenceInfo;

it('binds canonical captures to the actual invoking renderer, not a renderer-supplied recipient', () => {
  const first = new DraftSender(), second = new DraftSender(), id = open(first), reference = quote(first, id);
  expect(store.readReference(reference.id)).toBeDefined();
  expect(() => invoke('claim-draft-references', second, id, [reference.id])).toThrow('expired');
  expect(() => invoke('release-reference-draft', second, id)).toThrow('expired');
  expect(() => quote(second, id)).toThrow('expired');
  invoke('release-reference-draft', first, id); expect(store.readReference(reference.id)).toBeUndefined();
});

it('rejects foreign/old frames and never reuses a lease across a same-webContents reload', () => {
  const sender = new DraftSender(), id = open(sender), reference = quote(sender, id), oldEvent = sender.event();
  sender.navigate();
  expect(store.readReference(reference.id)).toBeUndefined(); expect(revoke).toHaveBeenCalledOnce();
  expect(() => open(sender)).toThrow('重新加载');
  sender.emit('did-stop-loading');
  expect(() => ipc.handlers.get('cloudhelm:open-reference-draft')!(oldEvent, { hostId: 'host' })).toThrow('重新加载');
  const next = open(sender); expect(next).not.toBe(id); expect(() => quote(sender, id)).toThrow('expired');
  expect(sender.listenerCount('did-start-navigation')).toBe(1);
});

it.each(['render-process-gone', 'destroyed'])('releases the retired recipient after %s without affecting another window', (event) => {
  const first = new DraftSender(), second = new DraftSender(), a = open(first), b = open(second);
  const reference = quote(first, a); invoke('claim-draft-references', second, b, [reference.id]);
  first.emit(event); expect(store.readReference(reference.id)).toBeDefined();
  invoke('release-reference-draft', second, b); expect(store.readReference(reference.id)).toBeUndefined();
});

it('preserves leases across fragment and subframe navigation', () => {
  const sender = new DraftSender(), id = open(sender), reference = quote(sender, id);
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  invoke('claim-draft-references', sender, id, [reference.id]); expect(revoke).not.toHaveBeenCalled();
});

it('retains a durable cleanup retry when storage fails during renderer retirement', () => {
  const sender = new DraftSender(), id = open(sender), reference = quote(sender, id);
  const remove = store.removeReference.bind(store);
  vi.spyOn(store, 'removeReference').mockImplementation((key) => { remove(key); throw new Error('synthetic cleanup failure'); });
  sender.emit('render-process-gone'); expect(store.readReference(reference.id)).toBeDefined();
  expect(() => open(sender)).toThrow('synthetic cleanup failure');
  vi.restoreAllMocks(); open(sender); expect(store.readReference(reference.id)).toBeUndefined();
});

it('refuses a deleting target before creating a draft', () => {
  expect(() => invoke('open-reference-draft', new DraftSender(), { hostId: 'host', conversationId: 'deleting' })).toThrow('conversation deleting');
});
