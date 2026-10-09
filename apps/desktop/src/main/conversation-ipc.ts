import { modelThinking } from '@cloudhelm/adapters';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import type { ClarificationAnswer, ConversationStart, LocalScope, ModelChoice, TaskView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';

interface Dependencies {
  sessionRoot: string;
  state: AppState;
  runtime: RuntimeBridge;
  connectHost(id: string): Promise<void>;
  takeSelections(tokens: string[]): LocalScope[];
  restoreSelections(tokens: string[], scopes: LocalScope[]): void;
}

export function registerConversationIpc({ sessionRoot, state, runtime, connectHost, takeSelections, restoreSelections }: Dependencies): void {
  function sessionDirectory(task: TaskView): string {
    if (!task.session || task.session.version !== 1 || task.session.id !== task.id || !/^[a-zA-Z0-9-]+$/u.test(task.id)) {
      throw new Error('旧对话仅供查看，请开始新对话。原生会话绑定不可用。');
    }
    return join(sessionRoot, task.session.id);
  }
  const restoring = new Map<string, Promise<void>>();
  async function ensureRuntime(task: TaskView): Promise<void> {
    if (task.hostIds.length > 1) throw new Error('旧的多主机对话仅供查看，请在目标主机开始新的单主机对话。');
    sessionDirectory(task);
    const pending = restoring.get(task.id);
    if (pending) return pending;
    const restore = restoreRuntime(task).finally(() => restoring.delete(task.id));
    restoring.set(task.id, restore);
    return restore;
  }
  async function restoreRuntime(task: TaskView): Promise<void> {
    const exists = await runtime.call<boolean>({ method: 'has-task', taskId: task.id });
    const profile = exists ? undefined : state.conversationProfile(task);
    for (const id of task.hostIds) if (state.getHost(id).status !== 'connected') await connectHost(id);
    if (exists) return;
    const snapshot = state.snapshot();
    await runtime.call({ method: 'start-task', task, restored: true,
      hosts: task.hostIds.map((id) => state.runtimeHost(id)),
      profile: profile!,
      priorOperations: snapshot.operations.filter((operation) => operation.taskId === task.id),
      sessionDirectory: sessionDirectory(task) });
  }

  ipcMain.handle('cloudhelm:start-conversation', async (_event, input: ConversationStart) => {
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100_000
      || (input.hostId !== null && (typeof input.hostId !== 'string' || !input.hostId.trim()))) throw new Error('请输入有效内容并选择主机');
    const profile = state.runtimeProfile(input.model);
    if (input.thinkingLevel !== undefined && !modelThinking(profile).levels.includes(input.thinkingLevel)) throw new Error('当前模型不支持此思考档位');
    if (input.hostId && state.getHost(input.hostId).status !== 'connected') await connectHost(input.hostId);
    const scopes = takeSelections(input.localSelectionTokens);
    let persisted = false;
    try {
      const task = state.createTask(input.message, input.hostId ? [input.hostId] : [], profile.modelId, scopes);
      persisted = true;
      state.setTaskModel(task.id, profile);
      await runtime.call({ method: 'start-task', task, thinkingLevel: input.thinkingLevel, sessionDirectory: sessionDirectory(task), hosts: task.hostIds.map((id) => state.runtimeHost(id)), profile });
      return task;
    } catch (error) {
      if (!persisted) restoreSelections(input.localSelectionTokens, scopes);
      throw error;
    }
  });

  ipcMain.handle('cloudhelm:send-message', async (_event, id: string, text: string, tokens: string[]) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('请输入有效内容');
    const task = state.getTask(id);
    if (task.status === 'waiting-user') throw new Error('请先回答需求澄清，或停止本轮对话');
    await ensureRuntime(task);
    const scopes = takeSelections(tokens);
    try {
      if (scopes.length) {
        await runtime.call({ method: 'authorize-task', taskId: id, hosts: [], localScopes: scopes });
        state.authorizeTask(id, [], scopes);
      }
      await runtime.call({ method: 'task-message', taskId: id, text });
    } catch (error) { restoreSelections(tokens, scopes); throw error; }
  });

  ipcMain.handle('cloudhelm:set-conversation-thinking', async (_event, id: string, level: import('@cloudhelm/contracts').ThinkingLevel) => {
    await ensureRuntime(state.getTask(id));
    await runtime.call({ method: 'set-conversation-thinking', taskId: id, level });
  });

  ipcMain.handle('cloudhelm:set-conversation-model', async (_event, id: string, choice: ModelChoice) => {
    sessionDirectory(state.getTask(id));
    const profile = state.runtimeProfile(choice);
    const live = await runtime.call<boolean>({ method: 'has-task', taskId: id });
    if (live) {
      await runtime.call({ method: 'set-conversation-model', taskId: id, profile });
    }
    state.setTaskModel(id, profile, live);
  });
  ipcMain.handle('cloudhelm:resume-task', async (_event, id: string) => {
    await ensureRuntime(state.getTask(id));
    await runtime.call({ method: 'resume-task', taskId: id });
  });
  ipcMain.handle('cloudhelm:answer-clarification', (_event, taskId: string, requestId: string, answers: ClarificationAnswer[]) => {
    state.getTask(taskId);
    return runtime.call({ method: 'answer-clarification', taskId, requestId, answers });
  });
  ipcMain.handle('cloudhelm:cancel-clarification', (_event, taskId: string, requestId: string) => {
    state.getTask(taskId);
    return runtime.call({ method: 'cancel-clarification', taskId, requestId });
  });
  ipcMain.handle('cloudhelm:stop-operation', (_event, id: string) => runtime.call({ method: 'stop-operation', taskId: id }));
  ipcMain.handle('cloudhelm:delete-conversation', async (_event, id: string) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 120) throw new Error('Invalid conversation id');
    // Authoritative state decides deletability before any runtime cleanup.
    state.assertDeletable(id);
    if (await runtime.call<boolean>({ method: 'has-task', taskId: id })) await runtime.call({ method: 'delete-task', taskId: id });
    const task = state.getTask(id);
    if (task.session) await rm(sessionDirectory(task), { recursive: true, force: true });
    state.deleteTask(id);
  });
}
