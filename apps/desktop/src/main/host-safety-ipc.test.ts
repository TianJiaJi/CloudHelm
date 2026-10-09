import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import { registerHostSafetyIpc } from './host-safety-ipc.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, handler: (...args: any[]) => unknown) => handlers.set(id, handler) } }));
const invoke = (name: string, ...args: unknown[]) => handlers.get(`cloudhelm:${name}`)!({}, ...args);
beforeEach(() => handlers.clear());
function setup() {
  const host = { id: 'host', defaultMode: 'ask', policyRevision: 1, protectedPaths: ['/protected'] } as HostView;
  const call = vi.fn(async () => undefined);
  const state = { getHost: () => host, updateHost: vi.fn((_id, change) => Object.assign(host, change)) };
  registerHostSafetyIpc(state as unknown as AppState, { call } as unknown as RuntimeBridge);
  return { host, call, state };
}
describe('host review mode IPC', () => {
  it('serializes full and mode-only edits, preserving latest protected paths and distinct revisions', async () => {
    const { host, call } = setup();
    await Promise.all([invoke('update-host-safety', 'host', 'ai-review', ['/new']), invoke('update-host-review-mode', 'host', 'permissive')]);
    expect(host).toMatchObject({ defaultMode: 'permissive', protectedPaths: ['/new'], policyRevision: 3 });
    expect(call.mock.calls).toEqual([
      [{ method: 'update-host-safety', hostId: 'host', mode: 'ai-review', protectedPaths: ['/new'], revision: 2 }],
      [{ method: 'update-host-safety', hostId: 'host', mode: 'permissive', protectedPaths: ['/new'], revision: 3 }]
    ]);
  });
  it('retains authoritative mode on runtime failure and allows subsequent retry', async () => {
    const { host, call, state } = setup();
    call.mockRejectedValueOnce(new Error('runtime disconnected'));
    await expect(invoke('update-host-review-mode', 'host', 'permissive')).rejects.toThrow('disconnected');
    expect(state.updateHost).not.toHaveBeenCalled();
    expect(host.policyRevision).toBe(1);
    await invoke('update-host-review-mode', 'host', 'ai-review');
    expect(host).toMatchObject({ policyRevision: 2, protectedPaths: ['/protected'] });
  });
  it('rejects invalid modes before updating runtime', async () => {
    const { call } = setup();
    await expect(invoke('update-host-review-mode', 'host', 'root')).rejects.toThrow('Invalid safety');
    expect(call).not.toHaveBeenCalled();
  });
});
