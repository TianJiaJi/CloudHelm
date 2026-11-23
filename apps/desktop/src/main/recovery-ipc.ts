import { ipcMain } from 'electron';
import { operationNeedsVerification, operationOutcomeResolvable, sharesHostRiskDomain, type AppSnapshot, type OperationView, type RecoveryActionOutcome, type RecoveryActionRequest, type TaskStatus, type TaskView } from '@cloudhelm/contracts';
import { redactOutput } from '@cloudhelm/core';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

function assertRecoveryContext(snapshot: AppSnapshot, operation: OperationView, sourceTaskId?: string, evidenceOperationIds?: string[]): void {
  if (sourceTaskId !== undefined && !snapshot.conversations.some((task) => task.id === sourceTaskId
    && task.hostIds.some((id) => sharesHostRiskDomain(snapshot.hostRiskBindings, id, operation.hostId)))) {
    throw new Error('恢复来源对话不属于此风险域');
  }
  // A shared risk domain does not prove a different connection observed the original recipient.
  if (evidenceOperationIds !== undefined && (!Array.isArray(evidenceOperationIds) || evidenceOperationIds.length > 20
    || evidenceOperationIds.some((id) => typeof id !== 'string') || new Set(evidenceOperationIds).size !== evidenceOperationIds.length
    || !evidenceOperationIds.every((id) => snapshot.operations.some((item) => item.id === id && item.hostId === operation.hostId
      && item.createdAt > operation.createdAt && item.status === 'succeeded' && item.readOnly)))) {
    throw new Error('只能引用同主机较新的成功只读核验操作');
  }
}

/** Control-generation proxy of the conversation to continue: any control
 * change between the decision and the dispatch suppresses the automatic
 * continuation, so a late acceptance never wakes a user-stopped task. */
function controlFingerprint(task: TaskView): string {
  return JSON.stringify([task.status, task.resumeReason ?? null, task.updatedAt, task.requestCount]);
}

const RESUMABLE_STATUSES: readonly TaskStatus[] = ['paused', 'failed', 'human-control', 'recovering'];
const LIVE_STATUSES: readonly TaskStatus[] = ['running', 'waiting-review', 'waiting-user'];

/** Post-release continuation of `accept-and-continue`. Every skip keeps the
 * honest reason instead of silently resuming; conditions mirror the manual
 * 「继续 AI」path, never bypassing authorization or budget checks. */
async function continueConversation(state: AppState, resumeTask: ((id: string) => Promise<void>) | undefined,
  request: RecoveryActionRequest, operation: OperationView, beforeControl: string | undefined): Promise<RecoveryActionOutcome> {
  const released: RecoveryActionOutcome = { actionId: request.actionId, action: request.action, released: true, resumed: false };
  if (!request.sourceTaskId) return { ...released, note: '未指定要继续的对话' };
  if (!resumeTask) return { ...released, note: '续跑通道不可用，请手动继续对话' };
  const snapshot = state.snapshot();
  const task = snapshot.conversations.find((item) => item.id === request.sourceTaskId);
  if (!task) return { ...released, note: '要继续的对话不存在或已删除' };
  if (!task.hostIds.some((id) => sharesHostRiskDomain(snapshot.hostRiskBindings, id, operation.hostId))) {
    return { ...released, note: '对话已不再授权此风险域，不能自动续跑' };
  }
  if (snapshot.operations.some((item) => item.id !== operation.id
    && sharesHostRiskDomain(snapshot.hostRiskBindings, item.hostId, operation.hostId) && operationNeedsVerification(item))) {
    return { ...released, note: '同风险域仍有其他待核验操作，全部解除后才会续跑' };
  }
  if (beforeControl !== undefined && controlFingerprint(task) !== beforeControl) {
    return { ...released, note: '对话控制状态在处置期间已变化，未自动续跑；请手动继续' };
  }
  if (task.resumeReason === 'report') return { ...released, note: '报告记录不是待执行工作；请发送新消息说明需求。' };
  if (LIVE_STATUSES.includes(task.status)) return { ...released, note: '对话仍在运行或等待中，无需续跑' };
  if (!RESUMABLE_STATUSES.includes(task.status)) return { ...released, note: '当前对话状态不需要续跑' };
  try {
    await resumeTask(request.sourceTaskId);
    return { ...released, resumed: true };
  } catch (error) {
    return { ...released, note: error instanceof Error ? error.message : '续跑失败，请手动继续' };
  }
}

/** The main process owns persisted outcomes; the worker owns live process liveness. */
export function registerRecoveryIpc(state: AppState, runtime: RuntimeBridge,
  resumeTask?: (id: string) => Promise<void>): void {
  ipcMain.handle('cloudhelm:read-recovery-operation-log', (_event, operationId: string, cursor: number) => {
    const operation = state.snapshot().operations.find((item) => item.id === operationId);
    if (!operation || !operationOutcomeResolvable(operation)) throw new Error('该操作不在待核验列表中');
    return state.readOperationLog(operation.taskId, operationId, cursor);
  });
  ipcMain.handle('cloudhelm:resolve-operation-risk', async (_event, request: RecoveryActionRequest) => {
    if (!request || typeof request !== 'object') throw new Error('无效的恢复处置请求');
    const { actionId, action, operationId } = request;
    if (typeof actionId !== 'string' || actionId.length < 8 || actionId.length > 100) throw new Error('无效的恢复动作标识');
    if (action !== 'reject' && action !== 'release' && action !== 'accept-and-continue') throw new Error('无效的恢复处置动作');
    if (typeof operationId !== 'string' || !operationId) throw new Error('无效的操作标识');
    if (request.sourceTaskId !== undefined && (typeof request.sourceTaskId !== 'string' || !request.sourceTaskId)) throw new Error('无效的恢复来源对话');
    const explanation = typeof request.explanation === 'string' ? request.explanation.trim() : '';
    if (action === 'reject') {
      if (explanation.length > 1000) throw new Error('拒绝说明过长（最多 1000 字符）');
    } else {
      if (explanation.length < 10 || explanation.length > 1000) throw new Error('请说明风险确认理由（10–1000 字符）');
      if (redactOutput(explanation) !== explanation || /(?:password|passwd|api[_-]?key|token|secret|otp|验证码|密码)\s+(?:is|为|是|equals?)\s*\S+/iu.test(explanation)) {
        throw new Error('风险说明不能包含密码、验证码或密钥；请仅描述检查结果');
      }
    }
    const snapshot = state.snapshot();
    const operation = snapshot.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error('该操作没有可确认的未知结果');
    // Idempotent replay: the durable decision record is authoritative; duplicate
    // clicks, timeouts and late responses with the same action id never re-execute.
    // Checked before the resolvable gate: a released operation is no longer
    // resolvable, but its recorded outcome must still replay.
    const prior = operation.recoveryDecision;
    if (prior?.actionId === actionId) {
      if (prior.error) throw new Error(prior.error);
      return { actionId, action: prior.action, released: prior.released, resumed: prior.resumed,
        ...(prior.resumeNote ? { note: prior.resumeNote } : {}) };
    }
    if (!operationOutcomeResolvable(operation)) throw new Error('该操作没有可确认的未知结果');
    if (action === 'reject') {
      state.recoveryDecisions.recordRejection(operationId, actionId, Date.now(), request.sourceTaskId, explanation || undefined);
      return { actionId, action, released: false, resumed: false };
    }
    assertRecoveryContext(snapshot, operation, request.sourceTaskId, request.evidenceOperationIds);
    const before = request.sourceTaskId ? snapshot.conversations.find((task) => task.id === request.sourceTaskId) : undefined;
    const beforeControl = before ? controlFingerprint(before) : undefined;
    const at = Date.now();
    // First verify that no foreground completion is still pending, without
    // releasing the host lock. Persist before dispatching the release: failed
    // storage never opens a write window for another task.
    await runtime.call({ method: 'prepare-operation-risk', operationId, hostId: operation.hostId });
    const latestSnapshot = state.snapshot(), latest = latestSnapshot.operations.find((item) => item.id === operationId);
    if (!latest || latest.hostId !== operation.hostId || latest.taskId !== operation.taskId || !operationOutcomeResolvable(latest)) {
      throw new Error('待核验操作已变化，请重新确认');
    }
    assertRecoveryContext(latestSnapshot, latest, request.sourceTaskId, request.evidenceOperationIds);
    const accepted = state.recoveryDecisions.accept(operationId, explanation, at, request.sourceTaskId,
      request.evidenceOperationIds, { action, actionId });
    let outcome: RecoveryActionOutcome;
    try {
      await runtime.call({ method: 'commit-operation-risk', operation: accepted });
      outcome = { actionId, action, released: true, resumed: false };
    } catch (error) {
      // An RPC error cannot prove whether the worker released the lock before
      // its response was lost. The durable explicit acceptance is still valid;
      // rolling it back could leave an unlocked worker with no acceptance record.
      const message = '风险确认已保存，但写锁同步状态未确认；请重启应用重新加载记录，不要重放原命令';
      state.recoveryDecisions.update(operationId, { resumed: false, error: message });
      throw new Error(message, { cause: error });
    }
    if (action !== 'accept-and-continue') return outcome;
    const continuation = await continueConversation(state, resumeTask, request, latest, beforeControl);
    state.recoveryDecisions.update(operationId, { resumed: continuation.resumed, ...(continuation.note ? { resumeNote: continuation.note } : {}) });
    return continuation;
  });
}
