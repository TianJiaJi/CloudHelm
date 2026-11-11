import { beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { registerRecoveryIpc } from '../../../apps/desktop/src/main/recovery-ipc.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, handler: (...args: any[]) => unknown) => handlers.set(id, handler) } }));
const invoke = (...args: unknown[]) => handlers.get('cloudhelm:accept-operation-risk')!({}, ...args);
beforeEach(() => handlers.clear());

function setup() {
  const original: OperationView = { id: 'old', taskId: 'source', hostId: 'host', kind: 'command', preview: 'old write', status: 'unknown', createdAt: 1 };
  const operations: OperationView[] = [original, { ...original, id: 'check', taskId: 'current', status: 'succeeded', readOnly: true, createdAt: 2 }];
  const snapshot = { operations, conversations: [{ id: 'current', hostIds: ['host'] }] };
  const acceptOperationRisk = vi.fn((id: string, explanation: string, at: number, sourceTaskId?: string, evidenceOperationIds?: string[]) => {
    const index = operations.findIndex((operation) => operation.id === id);
    const accepted: OperationView = { ...operations[index]!, reconciledAt: at,
      reconciliation: { kind: 'risk-accepted', explanation, at, sourceTaskId, evidenceOperationIds } };
    operations[index] = accepted;
    return structuredClone(accepted);
  });
  const readOperationLog = vi.fn((_task: string, _id: string, _cursor: number) => ({ text: 'redacted output', nextCursor: 15, more: false }));
  const call = vi.fn(async (_request: unknown) => undefined);
  registerRecoveryIpc({ snapshot: () => snapshot, acceptOperationRisk, readOperationLog } as unknown as AppState,
    { call } as unknown as RuntimeBridge);
  return { snapshot, acceptOperationRisk, call, readOperationLog };
}

it('allows explicit risk acceptance from a backend-linked revision but releases only the original operation', async () => {
  const { call, snapshot, acceptOperationRisk } = setup();
  snapshot.conversations[0]!.hostIds = ['new-profile'];
  Object.assign(snapshot, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'new-profile', riskDomainId: 'host' }
  ] });
  await invoke('old', '已检查并明确接管历史配置的未知操作风险', 'current', []);
  expect(acceptOperationRisk).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]![0]).toMatchObject({ method: 'prepare-operation-risk', operationId: 'old', hostId: 'host' });
  expect(call.mock.calls[1]![0]).toMatchObject({ method: 'commit-operation-risk', operation: { id: 'old', hostId: 'host', status: 'unknown' } });
});

it('does not treat shared risk identity as proof that another connection observed the original recipient', async () => {
  const { call, snapshot, acceptOperationRisk } = setup();
  snapshot.conversations[0]!.hostIds = ['new-profile'];
  snapshot.operations[1]!.hostId = 'new-profile';
  Object.assign(snapshot, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'new-profile', riskDomainId: 'host' }
  ] });
  await expect(invoke('old', '已检查并明确接管历史配置的未知操作风险', 'current', ['check'])).rejects.toThrow('只能引用同主机');
  expect(call).not.toHaveBeenCalled(); expect(acceptOperationRisk).not.toHaveBeenCalled();
});

it('refuses an unrelated risk domain even when a caller claims the current conversation', async () => {
  const { call, snapshot, acceptOperationRisk } = setup();
  snapshot.conversations[0]!.hostIds = ['unrelated'];
  Object.assign(snapshot, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'unrelated', riskDomainId: 'unrelated' }
  ] });
  await expect(invoke('old', '已检查并明确接管历史配置的未知操作风险', 'current', [])).rejects.toThrow('不属于此风险域');
  expect(call).not.toHaveBeenCalled(); expect(acceptOperationRisk).not.toHaveBeenCalled();
});

it.each(['source', 'evidence', 'recipient'] as const)('revalidates %s after awaiting worker liveness, before persisting or unlocking', async (change) => {
  const { call, snapshot, acceptOperationRisk } = setup();
  call.mockImplementationOnce(async () => {
    if (change === 'source') snapshot.conversations[0]!.hostIds = ['unrelated'];
    if (change === 'evidence') snapshot.operations[1]!.status = 'unknown';
    if (change === 'recipient') snapshot.operations[0] = { ...snapshot.operations[0]!, hostId: 'unrelated' };
  });
  await expect(invoke('old', '已检查并明确接管历史配置的未知操作风险', 'current', ['check'])).rejects.toThrow();
  expect(acceptOperationRisk).not.toHaveBeenCalled();
  expect(call.mock.calls.map(([request]) => (request as { method: string }).method)).toEqual(['prepare-operation-risk']);
});

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
  expect(call.mock.calls[1]?.[0]).toMatchObject({ method: 'commit-operation-risk', operation: {
    id: 'old', status: 'unknown', reconciledAt: expect.any(Number),
    reconciliation: { kind: 'risk-accepted', sourceTaskId: 'current', evidenceOperationIds: ['check'] }
  } });
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
