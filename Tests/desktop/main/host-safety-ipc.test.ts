import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostView } from '@cloudhelm/contracts';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { registerHostSafetyIpc } from '../../../apps/desktop/src/main/host-safety-ipc.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, handler: (...args: any[]) => unknown) => handlers.set(id, handler) } }));
const invoke = (name: string, ...args: unknown[]) => handlers.get(`cloudhelm:${name}`)!({}, ...args);
beforeEach(() => handlers.clear());
function setup() {
  const host = { id: 'host', defaultMode: 'ask', policyRevision: 1, protectedPaths: ['/protected'] } as HostView;
  const call = vi.fn(async (_request: unknown) => undefined);
  const state = { getHost: () => host, updateHost: vi.fn((_id, change) => Object.assign(host, change)) };
  registerHostSafetyIpc(state as unknown as AppState, { call } as unknown as RuntimeBridge);
  return { host, call, state };
}
describe('host review mode IPC', () => {
  it('serializes full and mode-only edits, preserving latest protected paths and distinct revisions', async () => {
    const { host, call } = setup();
    await Promise.all([invoke('update-host-safety', 'host', 'ai-review', ['/read'], ['/write']), invoke('update-host-review-mode', 'host', 'permissive')]);
    expect(host).toMatchObject({ defaultMode: 'permissive', protectedReadPaths: ['/read'], protectedWritePaths: ['/write'], policyRevision: 3 });
    expect(call.mock.calls).toEqual([
      [{ method: 'update-host-safety', hostId: 'host', mode: 'ai-review', protectedReadPaths: ['/read'], protectedWritePaths: ['/write'], revision: 2 }],
      [{ method: 'update-host-safety', hostId: 'host', mode: 'permissive', protectedReadPaths: ['/read'], protectedWritePaths: ['/write'], revision: 3 }]
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
  it('accepts the preauthorized mode as a host default', async () => {
    const { host } = setup();
    await invoke('update-host-review-mode', 'host', 'preauthorized');
    expect(host).toMatchObject({ defaultMode: 'preauthorized', policyRevision: 2 });
  });
});

describe('host pre-authorization scope IPC', () => {
  const scope = { revision: 1, commands: [{ program: 'systemctl', argumentPrefix: ['status'] }], paths: ['/srv/app'], kinds: ['write-file' as const] };
  it('validates, persists and forwards a declared scope with a policy revision bump', async () => {
    const { host, call, state } = setup();
    await invoke('update-host-preauthorization', 'host', scope);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![0]).toMatchObject({ method: 'update-host-safety', hostId: 'host', mode: 'ask',
      protectedReadPaths: ['/protected'], protectedWritePaths: ['/protected'], revision: 2, preauthorization: scope });
    expect(state.updateHost).toHaveBeenCalledWith('host', expect.objectContaining({ preauthorization: scope, policyRevision: 2 }));
    expect(host.preauthorization).toEqual(scope);
  });
  it('clears the scope with an explicit null and forwards null to the worker', async () => {
    const { call } = setup();
    await invoke('update-host-preauthorization', 'host', null);
    expect(call.mock.calls[0]![0]).toMatchObject({ method: 'update-host-safety', preauthorization: null });
  });
  it('rejects structurally or semantically invalid scopes before any update', async () => {
    const { call, state } = setup();
    for (const invalid of [
      { ...scope, paths: ['srv/relative'] },
      { ...scope, paths: ['/srv/../etc'] },
      { ...scope, paths: ['/srv/app/'] },
      { ...scope, commands: [{ program: 'bash' }] },
      { ...scope, commands: [{ program: 'a b' }] },
      { ...scope, kinds: ['reboot' as never] },
      { ...scope, revision: 0 },
      { commands: [], paths: [], kinds: [], revision: '1' as never }
    ]) {
      await expect(invoke('update-host-preauthorization', 'host', invalid)).rejects.toThrow();
    }
    expect(call).not.toHaveBeenCalled();
    expect(state.updateHost).not.toHaveBeenCalled();
  });
});
