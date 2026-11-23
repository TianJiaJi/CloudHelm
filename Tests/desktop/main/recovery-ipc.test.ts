import { beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../../apps/desktop/src/main/app-state.js';
import type { OperationView, RecoveryActionKind, RecoveryActionOutcome, RecoveryActionRequest, RecoveryDecisionRecord } from '@cloudhelm/contracts';
import type { RuntimeBridge } from '../../../apps/desktop/src/main/runtime-bridge.js';
import { registerRecoveryIpc } from '../../../apps/desktop/src/main/recovery-ipc.js';
import { randomUUID } from 'node:crypto';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, handler: (...args: any[]) => unknown) => handlers.set(id, handler) } }));
const invoke = (request: unknown) => handlers.get('cloudhelm:resolve-operation-risk')!({}, request);
beforeEach(() => handlers.clear());

function setup() {
  const original: OperationView = { id: 'old', taskId: 'source', hostId: 'host', kind: 'command', preview: 'old write', status: 'unknown', createdAt: 1 };
  const operations: OperationView[] = [original, { ...original, id: 'check', taskId: 'current', hostId: 'host', status: 'succeeded', readOnly: true, createdAt: 2 }];
  const view = {
    operations,
    conversations: [{ id: 'current', hostIds: ['host'], status: 'paused', resumeReason: 'verify', updatedAt: 5, requestCount: 1 }]
  };
  const accept = vi.fn((id: string, explanation: string, at: number, sourceTaskId?: string, evidenceOperationIds?: string[],
    disposition?: { action: RecoveryActionKind; actionId: string }) => {
    const index = operations.findIndex((operation) => operation.id === id);
    const accepted: OperationView = { ...operations[index]!, reconciledAt: at,
      reconciliation: { kind: 'risk-accepted', explanation, at, sourceTaskId, evidenceOperationIds, ...(disposition ? { action: disposition.action } : {}) },
      ...(disposition ? { recoveryDecision: { version: 1, actionId: disposition.actionId, action: disposition.action, at,
        ...(sourceTaskId ? { sourceTaskId } : {}), released: true, resumed: false } satisfies RecoveryDecisionRecord } : {}) };
    operations[index] = accepted;
    return structuredClone(accepted);
  });
  const recordRejection = vi.fn((id: string, actionId: string, at: number, sourceTaskId?: string, explanation?: string) => {
    const index = operations.findIndex((operation) => operation.id === id);
    const rejected: OperationView = { ...operations[index]!,
      recoveryDecision: { version: 1, actionId, action: 'reject', at, ...(sourceTaskId ? { sourceTaskId } : {}),
        ...(explanation ? { explanation } : {}), released: false, resumed: false } satisfies RecoveryDecisionRecord };
    operations[index] = rejected;
    return structuredClone(rejected);
  });
  const update = vi.fn((id: string, patch: Partial<RecoveryDecisionRecord>) => {
    const index = operations.findIndex((operation) => operation.id === id);
    operations[index] = { ...operations[index]!, recoveryDecision: { ...operations[index]!.recoveryDecision!, ...patch } };
  });
  const readOperationLog = vi.fn((_task: string, _id: string, _cursor: number) => ({ text: 'redacted output', nextCursor: 15, more: false }));
  const call = vi.fn(async (_request: unknown) => undefined);
  const resumeTask = vi.fn(async (_id: string) => undefined);
  registerRecoveryIpc({ snapshot: () => view, readOperationLog,
    recoveryDecisions: { accept, recordRejection, update } } as unknown as AppState,
    { call } as unknown as RuntimeBridge, resumeTask);
  return { view, accept, recordRejection, update, call, resumeTask, readOperationLog };
}

const request = (action: RecoveryActionKind, overrides: Partial<RecoveryActionRequest> = {}): RecoveryActionRequest => ({
  actionId: randomUUID(), action, operationId: 'old',
  explanation: '已检查并明确接管历史配置的未知操作风险', sourceTaskId: 'current', ...overrides
});

it('keeps the write lock when the user rejects, recording the decision without touching the worker', async () => {
  const { call, recordRejection, accept, view } = setup();
  const rejected = request('reject', { explanation: '用户在恢复卡明确拒绝接管未知结果风险，保持写入阻断。' });
  await expect(invoke(rejected)).resolves.toEqual({ actionId: rejected.actionId, action: 'reject', released: false, resumed: false });
  expect(recordRejection).toHaveBeenCalledOnce();
  expect(recordRejection).toHaveBeenCalledWith('old', rejected.actionId, expect.any(Number), 'current', '用户在恢复卡明确拒绝接管未知结果风险，保持写入阻断。');
  expect(accept).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
  expect(view.operations[0]!.reconciledAt).toBeUndefined();
});

it('replays a repeated reject with the same action id without recording twice', async () => {
  const { recordRejection } = setup();
  const rejected = request('reject');
  await invoke(rejected);
  await expect(invoke(rejected)).resolves.toEqual({ actionId: rejected.actionId, action: 'reject', released: false, resumed: false });
  expect(recordRejection).toHaveBeenCalledOnce();
});

it('releases the block for a release action without dispatching any continuation', async () => {
  const { accept, resumeTask, update, view } = setup();
  const action = request('release');
  await expect(invoke(action)).resolves.toEqual({ actionId: action.actionId, action: 'release', released: true, resumed: false });
  expect(accept).toHaveBeenCalledWith('old', action.explanation, expect.any(Number), 'current', undefined, { action: 'release', actionId: action.actionId });
  expect(resumeTask).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(view.operations[0]!.reconciliation?.action).toBe('release');
});

it('accept-and-continue releases and then continues the paused source conversation once', async () => {
  const { accept, resumeTask, update, view } = setup();
  const action = request('accept-and-continue');
  await expect(invoke(action)).resolves.toEqual({ actionId: action.actionId, action: 'accept-and-continue', released: true, resumed: true });
  expect(accept).toHaveBeenCalledWith('old', action.explanation, expect.any(Number), 'current', undefined, { action: 'accept-and-continue', actionId: action.actionId });
  expect(resumeTask).toHaveBeenCalledOnce();
  expect(resumeTask).toHaveBeenCalledWith('current');
  expect(update).toHaveBeenCalledWith('old', { resumed: true });
  expect(view.operations[0]!.reconciliation?.action).toBe('accept-and-continue');
});

it('does not wake the source conversation after its control state changed during the action', async () => {
  const { call, resumeTask, view } = setup();
  call.mockImplementationOnce(async () => {
    // The user stopped or steered the conversation while the acceptance was in flight.
    view.conversations[0]!.status = 'running';
    view.conversations[0]!.updatedAt = 99;
  });
  const outcome = await invoke(request('accept-and-continue')) as RecoveryActionOutcome;
  expect(outcome).toMatchObject({ released: true, resumed: false, note: '对话控制状态在处置期间已变化，未自动续跑；请手动继续' });
  expect(resumeTask).not.toHaveBeenCalled();
});

it('skips the continuation while other unresolved operations remain in the same risk domain', async () => {
  const { view, resumeTask } = setup();
  view.operations.push({ ...view.operations[0]!, id: 'other', taskId: 'source', hostId: 'host', status: 'unknown', createdAt: 3 });
  const outcome = await invoke(request('accept-and-continue')) as RecoveryActionOutcome;
  expect(outcome).toMatchObject({ released: true, resumed: false, note: '同风险域仍有其他待核验操作，全部解除后才会续跑' });
  expect(resumeTask).not.toHaveBeenCalled();
});

it('reports an honest note instead of resuming when the source conversation cannot be continued', async () => {
  const report = setup();
  report.view.conversations[0]!.resumeReason = 'report';
  await expect(invoke(request('accept-and-continue'))).resolves.toMatchObject({ resumed: false, note: '报告记录不是待执行工作；请发送新消息说明需求。' });
  const running = setup();
  running.view.conversations[0]!.status = 'running';
  await expect(invoke(request('accept-and-continue'))).resolves.toMatchObject({ resumed: false, note: '对话仍在运行或等待中，无需续跑' });
  const exhausted = setup();
  exhausted.resumeTask.mockRejectedValueOnce(new Error('预算已耗尽，请先追加请求预算'));
  await expect(invoke(request('accept-and-continue'))).resolves.toMatchObject({ resumed: false, note: '预算已耗尽，请先追加请求预算' });
  expect(report.resumeTask).not.toHaveBeenCalled();
  expect(running.resumeTask).not.toHaveBeenCalled();
  expect(exhausted.resumeTask).toHaveBeenCalledOnce();
});

it('replays a repeated accept-and-continue with the same action id without resuming twice', async () => {
  const { accept, resumeTask } = setup();
  const action = request('accept-and-continue');
  await invoke(action);
  await expect(invoke(action)).resolves.toEqual({ actionId: action.actionId, action: 'accept-and-continue', released: true, resumed: true });
  expect(accept).toHaveBeenCalledOnce();
  expect(resumeTask).toHaveBeenCalledOnce();
});

it('allows explicit risk acceptance from a backend-linked revision but releases only the original operation', async () => {
  const { call, view, accept } = setup();
  view.conversations[0]!.hostIds = ['new-profile'];
  Object.assign(view, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'new-profile', riskDomainId: 'host' }
  ] });
  await invoke(request('release'));
  expect(accept).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]![0]).toMatchObject({ method: 'prepare-operation-risk', operationId: 'old', hostId: 'host' });
  expect(call.mock.calls[1]![0]).toMatchObject({ method: 'commit-operation-risk', operation: { id: 'old', hostId: 'host', status: 'unknown' } });
});

it('does not treat shared risk identity as proof that another connection observed the original recipient', async () => {
  const { call, view, accept } = setup();
  view.conversations[0]!.hostIds = ['new-profile'];
  view.operations[1]!.hostId = 'new-profile';
  Object.assign(view, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'new-profile', riskDomainId: 'host' }
  ] });
  await expect(invoke(request('release', { evidenceOperationIds: ['check'] }))).rejects.toThrow('只能引用同主机');
  expect(call).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
});

it('refuses an unrelated risk domain even when a caller claims the current conversation', async () => {
  const { call, view, accept } = setup();
  view.conversations[0]!.hostIds = ['unrelated'];
  Object.assign(view, { hostRiskBindings: [
    { hostId: 'host', riskDomainId: 'host' }, { hostId: 'unrelated', riskDomainId: 'unrelated' }
  ] });
  await expect(invoke(request('release'))).rejects.toThrow('不属于此风险域');
  expect(call).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
});

it.each(['source', 'evidence', 'recipient'] as const)('revalidates %s after awaiting worker liveness, before persisting or unlocking', async (change) => {
  const { call, view, accept } = setup();
  call.mockImplementationOnce(async () => {
    if (change === 'source') view.conversations[0]!.hostIds = ['unrelated'];
    if (change === 'evidence') view.operations[1]!.status = 'unknown';
    if (change === 'recipient') view.operations[0] = { ...view.operations[0]!, hostId: 'unrelated' };
  });
  await expect(invoke(request('release', { evidenceOperationIds: ['check'] }))).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
  expect(call.mock.calls.map(([requestValue]) => (requestValue as { method: string }).method)).toEqual(['prepare-operation-risk']);
});

it('shows an unresolved original log only through the recovery-specific user path', async () => {
  const { readOperationLog, view } = setup();
  const read = handlers.get('cloudhelm:read-recovery-operation-log')!;
  expect(await read({}, 'old', 0)).toEqual({ text: 'redacted output', nextCursor: 15, more: false });
  expect(readOperationLog).toHaveBeenCalledWith('source', 'old', 0);
  view.operations[0]!.status = 'succeeded';
  expect(() => read({}, 'old', 0)).toThrow();
});

it('records one host-bound risk acceptance with newer successful read-only evidence', async () => {
  const { call, accept } = setup();
  const action = request('release', { explanation: '已核验远端状态并明确接受未知结果风险', evidenceOperationIds: ['check'] });
  await invoke(action);
  expect(call.mock.calls[0]?.[0]).toMatchObject({ method: 'prepare-operation-risk', operationId: 'old', hostId: 'host' });
  expect(accept).toHaveBeenCalledWith('old', '已核验远端状态并明确接受未知结果风险', expect.any(Number), 'current', ['check'], { action: 'release', actionId: action.actionId });
  expect(call.mock.calls[1]?.[0]).toMatchObject({ method: 'commit-operation-risk', operation: {
    id: 'old', status: 'unknown', reconciledAt: expect.any(Number),
    reconciliation: { kind: 'risk-accepted', sourceTaskId: 'current', evidenceOperationIds: ['check'], action: 'release' }
  } });
});

it('refuses an in-flight operation, a foreign conversation or forged evidence without touching the worker', async () => {
  const { call, view } = setup();
  view.operations[0]!.status = 'running';
  await expect(invoke(request('release'))).rejects.toThrow();
  view.operations[0]!.status = 'unknown';
  await expect(invoke(request('release', { sourceTaskId: 'foreign' }))).rejects.toThrow();
  await expect(invoke(request('release', { evidenceOperationIds: ['old'] }))).rejects.toThrow();
  await expect(invoke(request('release', { explanation: 'password=super-sensitive' }))).rejects.toThrow('不能包含');
  expect(call).not.toHaveBeenCalled();
});

it('does not persist when the remote process is still live', async () => {
  const { call, accept } = setup();
  call.mockRejectedValueOnce(new Error('仍在运行'));
  await expect(invoke(request('release'))).rejects.toThrow('仍在运行');
  expect(accept).not.toHaveBeenCalled();
});

it('keeps the write lock when persistence fails', async () => {
  const { call, accept } = setup();
  accept.mockImplementation(() => { throw new Error('disk full'); });
  await expect(invoke(request('release'))).rejects.toThrow('disk full');
  expect(call.mock.calls.map(([requestValue]) => (requestValue as { method: string }).method)).toEqual(['prepare-operation-risk']);
});

it('retains durable acceptance if the worker reply is lost after a possible release', async () => {
  const { call, accept, update } = setup();
  call.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(invoke(request('release'))).rejects.toThrow('风险确认已保存');
  expect(accept).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith('old', { resumed: false, error: '风险确认已保存，但写锁同步状态未确认；请重启应用重新加载记录，不要重放原命令' });
});

it('replays the recorded sync uncertainty for a late duplicate instead of re-executing the release', async () => {
  const { call, accept } = setup();
  const action = request('release');
  call.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(invoke(action)).rejects.toThrow('风险确认已保存');
  await expect(invoke(action)).rejects.toThrow('风险确认已保存');
  expect(accept).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledTimes(2);
});
