import { ipcMain } from 'electron';
import { operationOutcomeResolvable } from '@cloudhelm/contracts';
import { redactOutput } from '@cloudhelm/core';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

/** The main process owns persisted outcomes; the worker owns live process liveness. */
export function registerRecoveryIpc(state: AppState, runtime: RuntimeBridge): void {
  ipcMain.handle('cloudhelm:read-recovery-operation-log', (_event, operationId: string, cursor: number) => {
    const operation = state.snapshot().operations.find((item) => item.id === operationId);
    if (!operation || !operationOutcomeResolvable(operation)) throw new Error('该操作不在待核验列表中');
    return state.readOperationLog(operation.taskId, operationId, cursor);
  });
  ipcMain.handle('cloudhelm:accept-operation-risk', async (_event, operationId: string, explanation: string, sourceTaskId?: string, evidenceOperationIds?: string[]) => {
    const snapshot = state.snapshot();
    const operation = snapshot.operations.find((item) => item.id === operationId);
    if (!operation || !operationOutcomeResolvable(operation)) throw new Error('该操作没有可确认的未知结果');
    const reason = typeof explanation === 'string' ? explanation.trim() : '';
    if (reason.length < 10 || reason.length > 1000) throw new Error('请说明风险确认理由（10–1000 字符）');
    if (redactOutput(reason) !== reason || /(?:password|passwd|api[_-]?key|token|secret|otp|验证码|密码)\s+(?:is|为|是|equals?)\s*\S+/iu.test(reason)) {
      throw new Error('风险说明不能包含密码、验证码或密钥；请仅描述检查结果');
    }
    if (sourceTaskId !== undefined && !snapshot.conversations.some((task) => task.id === sourceTaskId && task.hostIds.includes(operation.hostId))) {
      throw new Error('恢复来源对话不属于此主机');
    }
    if (evidenceOperationIds !== undefined && (!Array.isArray(evidenceOperationIds) || evidenceOperationIds.length > 20
      || evidenceOperationIds.some((id) => typeof id !== 'string') || new Set(evidenceOperationIds).size !== evidenceOperationIds.length
      || !evidenceOperationIds.every((id) => snapshot.operations.some((item) => item.id === id && item.hostId === operation.hostId
        && item.createdAt > operation.createdAt && item.status === 'succeeded' && item.readOnly)))) {
      throw new Error('只能引用同主机较新的成功只读核验操作');
    }
    const at = Date.now();
    // First verify that no foreground completion is still pending, without
    // releasing the host lock. Persist before dispatching the release: failed
    // storage never opens a write window for another task.
    await runtime.call({ method: 'prepare-operation-risk', operationId, hostId: operation.hostId });
    const accepted = state.acceptOperationRisk(operationId, reason, at, sourceTaskId, evidenceOperationIds);
    try {
      await runtime.call({ method: 'commit-operation-risk', operation: accepted });
    } catch (error) {
      // An RPC error cannot prove whether the worker released the lock before
      // its response was lost. The durable explicit acceptance is still valid;
      // rolling it back could leave an unlocked worker with no acceptance record.
      throw new Error('风险确认已保存，但写锁同步状态未确认；请重启应用重新加载记录，不要重放原命令', { cause: error });
    }
  });
}
