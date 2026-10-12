import { beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import { registerRecoveryIpc } from './recovery-ipc.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, handler: (...args: any[]) => unknown) => handlers.set(id, handler) } }));
const invoke = (...args: unknown[]) => handlers.get('cloudhelm:accept-operation-risk')!({}, ...args);
beforeEach(() => handlers.clear());

function setup() {
  const original = { id: 'old', taskId: 'source', hostId: 'host', kind: 'command', status: 'unknown', createdAt: 1 };
  const snapshot = { operations: [original, { id: 'check', taskId: 'current', hostId: 'host', status: 'succeeded', readOnly: true, createdAt: 2 }],
    conversations: [{ id: 'current', hostIds: ['host'] }] };
  const acceptOperationRisk = vi.fn((_id: string, _reason: string, _at: number, _task?: string, _evidence?: string[]) => undefined);
  const readOperationLog = vi.fn((_task: string, _id: string, _cursor: number) => ({ text: 'redacted output', nextCursor: 15, more: false }));
  const call = vi.fn(async (_request: unknown) => undefined);
  registerRecoveryIpc({ snapshot: () => snapshot, acceptOperationRisk, readOperationLog } as unknown as AppState,
    { call } as unknown as RuntimeBridge);
  return { snapshot, acceptOperationRisk, call, readOperationLog };
}

it('shows an unresolved original log only through the recovery-specific user path', async () => {
  const { readOperationLog, snapshot } = setup();
  const read = handlers.get('cloudhelm:read-recovery-operation-log')!;
  expect(await read({}, 'old', 0)).toEqual({ text: 'redacted output', nextCursor: 15, more: false });
  expect(readOperationLog).toHaveBeenCalledWith('source', 'old', 0);
  snapshot.operations[0]!.status = 'succeeded';
  expect(() => read({}, 'old', 0)).toThrow();
});

it('records one host-bound risk acceptance with newer successful read-only evidence', async () => {
  const { call, acceptOperationRisk } = setup();
  await invoke('old', '已核验远端状态并明确接受未知结果风险', 'current', ['check']);
  expect(call.mock.calls[0]?.[0]).toMatchObject({ method: 'prepare-operation-risk', operationId: 'old', hostId: 'host' });
  expect(acceptOperationRisk).toHaveBeenCalledWith('old', '已核验远端状态并明确接受未知结果风险', expect.any(Number), 'current', ['check']);
  expect(call.mock.calls[1]?.[0]).toMatchObject({ method: 'commit-operation-risk', operationId: 'old' });
});

it('refuses an in-flight operation, a foreign conversation or forged evidence without touching the worker', async () => {
  const { call, snapshot } = setup();
  snapshot.operations[0]!.status = 'running';
  await expect(invoke('old', '已检查并承担未知远端执行风险')).rejects.toThrow();
  snapshot.operations[0]!.status = 'unknown';
  await expect(invoke('old', '已检查并承担未知远端执行风险', 'foreign')).rejects.toThrow();
  await expect(invoke('old', '已检查并承担未知远端执行风险', 'current', ['old'])).rejects.toThrow();
  await expect(invoke('old', 'password=super-sensitive')).rejects.toThrow('不能包含');
  expect(call).not.toHaveBeenCalled();
});

it('does not persist when the remote process is still live', async () => {
  const { call, acceptOperationRisk } = setup();
  call.mockRejectedValueOnce(new Error('仍在运行'));
  await expect(invoke('old', '已检查并承担未知远端执行风险')).rejects.toThrow('仍在运行');
  expect(acceptOperationRisk).not.toHaveBeenCalled();
});

it('keeps the write lock when persistence fails', async () => {
  const { call, acceptOperationRisk } = setup();
  acceptOperationRisk.mockImplementation(() => { throw new Error('disk full'); });
  await expect(invoke('old', '已检查并承担未知远端执行风险')).rejects.toThrow('disk full');
  expect(call.mock.calls.map(([request]) => (request as { method: string }).method)).toEqual(['prepare-operation-risk']);
});

it('retains durable acceptance if the worker reply is lost after a possible release', async () => {
  const { call, acceptOperationRisk } = setup();
  call.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(invoke('old', '已检查并承担未知远端执行风险')).rejects.toThrow('风险确认已保存');
  expect(acceptOperationRisk).toHaveBeenCalledOnce();
});
