import { registerStructuredMessageIpc } from './structured-message-ipc.js';
import { extendRequestBudget } from './extend-request-budget.js';
import { ExtendRequestBudgetSchema } from '@cloudhelm/contracts';
import { remainingRequests, RequestBudgetError } from '@cloudhelm/core';
import { Value } from 'typebox/value';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceStore } from './reference-store.js';
import type { MessageDocument } from '@cloudhelm/contracts';
import { BashAnalyzer, modelThinking } from '@cloudhelm/adapters';
import { finishConversationCleanup } from './conversation-cleanup.js';
import { ConversationLifecycle } from './conversation-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import type { ClarificationAnswer, ConversationStart, LocalScope, ModelChoice, TaskView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import type { PreparedContext } from '@cloudhelm/contracts/runtime';

interface Dependencies {
  store?: SqliteStore; references?: ReferenceStore;
  sessionRoot: string;
  cleanupConversation?(id: string): Promise<boolean>;
  state: AppState;
  runtime: RuntimeBridge;
  connectHost(id: string): Promise<void>;
  takeSelections(tokens: string[]): LocalScope[];
  restoreSelections(tokens: string[], scopes: LocalScope[]): void;
}

export function registerConversationIpc({ store, references, sessionRoot, cleanupConversation, state, runtime, connectHost, takeSelections, restoreSelections }: Dependencies): void {
  const lifecycle = new ConversationLifecycle();
  function handleTask<A extends unknown[], T>(name: string, action: (id: string, ...args: A) => T | Promise<T>): void {
    ipcMain.handle(`cloudhelm:${name}`, (_event, id: string, ...args: A) => lifecycle.use(id, () => action(id, ...args)));
  }
  const cleanup = cleanupConversation ?? ((id: string) => {
    if (!store) throw new Error('Conversation cleanup storage unavailable');
    return finishConversationCleanup(store, sessionRoot, id);
  });
  const pendingCleanup = () => new Error('对话记录已删除，本地会话文件清理尚未完成；已保留恢复记录，下次启动将重试。');
  function sessionDirectory(task: TaskView): string {
    if (task.hostIds.length > 1) throw new Error('旧的多主机对话仅供查看，请在目标主机开始新的单主机对话。');
    if (!task.session || task.session.version !== 1 || task.session.id !== task.id || !/^[a-zA-Z0-9-]+$/u.test(task.id)) {
      throw new Error('旧对话仅供查看，请开始新对话。原生会话绑定不可用。');
    }
    return join(sessionRoot, task.session.id);
  }
  const restoring = new Map<string, Promise<void>>();
  const ensureRuntime = (task: TaskView) => lifecycle.use(task.id, () => ensureRuntimeNow(task));
  async function ensureRuntimeNow(task: TaskView): Promise<void> {
    sessionDirectory(task);
    state.requestBudgets.complete(task.id);
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
    if (exists) {
      // Repair a reviewer update that was saved while its worker response failed.
      // This uses the live task identity without rebinding its model credentials.
      await runtime.call({ method: 'set-review-profile', taskId: task.id,
        reviewer: state.runtimeReviewerForLiveTask(task) });
      return;
    }
    const snapshot = state.snapshot();
    await runtime.call({ method: 'start-task', task, restored: true,
      hosts: task.hostIds.map((id) => state.runtimeHost(id)),
      profile: profile!,
      priorOperations: snapshot.operations.filter((operation) => operation.taskId === task.id), priorInputs: state.queuedInputs(task.id),
      sessionDirectory: sessionDirectory(task) });
  }

  async function start(input: ConversationStart, document?: MessageDocument, initialMessage?: string, intent?: string, assertPrepared?: (scopes: LocalScope[]) => void): Promise<TaskView> {
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100_000
      || (input.hostId !== null && (typeof input.hostId !== 'string' || !input.hostId.trim()))) throw new Error('请输入有效内容并选择主机');
    const profile = state.runtimeProfile(input.model);
    if (input.thinkingLevel !== undefined && !modelThinking(profile).levels.includes(input.thinkingLevel)) throw new Error('当前模型不支持此思考档位');
    if (input.hostId && state.getHost(input.hostId).status !== 'connected') await connectHost(input.hostId);
    const scopes = takeSelections(input.localSelectionTokens);
    let persisted = false;
    try {
      assertPrepared?.(scopes);
      const task = state.createTask(input.message, input.hostId ? [input.hostId] : [], profile.modelId, scopes);
      persisted = true;
      return await lifecycle.use(task.id, async () => {
        state.setTaskModel(task.id, profile);
        await runtime.call({ method: 'start-task', task, document, initialMessage, intent, thinkingLevel: input.thinkingLevel, sessionDirectory: sessionDirectory(task), hosts: task.hostIds.map((id) => state.runtimeHost(id)), profile });
        return task;
      });
    } catch (error) {
      if (!persisted) restoreSelections(input.localSelectionTokens, scopes);
      throw error;
    }
  }

  const send = (...args: Parameters<typeof sendNow>) => lifecycle.use(args[0], () => sendNow(...args));
  async function sendNow(id: string, text: string, tokens: string[], document?: MessageDocument, intent?: string, prepared?: PreparedContext, queueMode?: import('@cloudhelm/contracts').ConversationInputKind): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || (!document && text.length > 100_000)) throw new Error('请输入有效内容');
    const task = state.getTask(id);
    if (task.status === 'waiting-user') throw new Error('请先回答需求澄清，或停止本轮对话');
    sessionDirectory(task);
    // Capture factual completion BEFORE restoration can project the task as paused.
    state.requestBudgets.input(id, document?.requestId ?? randomUUID());
    await ensureRuntime(state.getTask(id));
    const scopes = takeSelections(tokens);
    try {
      if (scopes.length) {
        await runtime.call({ method: 'authorize-task', taskId: id, hosts: [], localScopes: scopes,
          ...(prepared ? { prepared: { ...prepared, text } } : {}) });
        state.authorizeTask(id, [], scopes);
      }
      await runtime.call({ method: 'task-message', taskId: id, text, document, intent, queueMode,
        ...(prepared ? { preparedRevision: prepared.revision } : {}) });
    } catch (error) { restoreSelections(tokens, scopes); throw error; }
  }
  ipcMain.handle('cloudhelm:rebuild-verification-report', (_event, id: string) => state.rebuildVerificationReport(id, new BashAnalyzer()));
  ipcMain.handle('cloudhelm:start-conversation', (_event, input: ConversationStart) => start(input));
  ipcMain.handle('cloudhelm:send-message', (_event, id: string, text: string, tokens: string[], queueMode?: unknown) => {
    if (typeof queueMode === 'string' && queueMode !== 'steer' && queueMode !== 'followUp') throw new Error('无效消息投递方式');
    // Legacy extra objects (including hostIds) never grant scope or choose a delivery mode.
    return send(id, text, tokens, undefined, undefined, undefined,
      queueMode === 'steer' || queueMode === 'followUp' ? queueMode : undefined);
  });
  handleTask('cancel-queued-input', async (taskId: string, inputId: string) => {
    state.getTask(taskId);
    const value = state.queuedInputs(taskId).find((entry) => entry.id === inputId);
    if (!value) throw new Error('消息不属于当前对话');
    if (!await runtime.call<boolean>({ method: 'has-task', taskId })) return { cancelled: false };
    const result = await runtime.call<{ cancelled: boolean }>({ method: 'cancel-queued-input', taskId, inputId });
    return { cancelled: result.cancelled }; // Prepared reference bodies never cross this renderer API.
  });
  if (store && references) registerStructuredMessageIpc({ state, store, runtime, references, start, send, ensureRuntime,
    assertConversationAvailable: (id) => lifecycle.assertAvailable(id),
    previewSelections: (tokens) => { const scopes = takeSelections(tokens); restoreSelections(tokens, scopes); return structuredClone(scopes); } });

  handleTask('set-conversation-thinking', async (id: string, level: import('@cloudhelm/contracts').ThinkingLevel) => {
    await ensureRuntime(state.getTask(id));
    await runtime.call({ method: 'set-conversation-thinking', taskId: id, level });
  });

  handleTask('set-conversation-model', async (id: string, choice: ModelChoice) => {
    sessionDirectory(state.getTask(id));
    const profile = state.runtimeProfile(choice);
    const live = await runtime.call<boolean>({ method: 'has-task', taskId: id });
    if (live) {
      await runtime.call({ method: 'set-conversation-model', taskId: id, profile });
    }
    state.setTaskModel(id, profile, live);
  });
  handleTask('resume-task', async (id: string) => {
    const task = state.getTask(id); sessionDirectory(task);
    if (task.resumeReason === 'report') throw new Error('报告记录不是待执行工作；请发送新消息说明需求。');
    if (remainingRequests(state.requestBudgets.current(id)) <= 0) throw new RequestBudgetError('budget-exhausted');
    await ensureRuntime(task);
    if (remainingRequests(state.requestBudgets.reopen(id)) <= 0) throw new RequestBudgetError('budget-exhausted');
    await runtime.call({ method: 'resume-task', taskId: id });
  });
  ipcMain.handle('cloudhelm:extend-request-budget', async (_event, input: unknown) => {
    try {
      if (!Value.Check(ExtendRequestBudgetSchema, input)) throw new RequestBudgetError('budget-invalid');
      sessionDirectory(state.getTask(input.taskId));
      return await lifecycle.use(input.taskId, () => extendRequestBudget(input, {
        authority: state.requestBudgets,
        live: (id) => {
          const execution = state.snapshot().execution?.[id];
          return { task: state.getTask(id), modelIdle: execution?.model === 'idle', remoteIdle: execution?.remote === 'idle' };
        },
        restore: (id) => ensureRuntime(state.getTask(id)),
        resume: (id) => runtime.call({ method: 'resume-task', taskId: id })
      }));
    } catch (error) {
      throw new Error(error instanceof RequestBudgetError ? error.code : '预算追加或继续确认失败；请核对当前状态，不会自动重试。');
    }
  });
  handleTask('answer-clarification', (taskId: string, requestId: string, answers: ClarificationAnswer[]) => {
    state.getTask(taskId);
    return runtime.call({ method: 'answer-clarification', taskId, requestId, answers });
  });
  handleTask('cancel-clarification', (taskId: string, requestId: string) => {
    state.getTask(taskId);
    return runtime.call({ method: 'cancel-clarification', taskId, requestId });
  });
  handleTask('stop-operation', (id: string) => runtime.call({ method: 'stop-operation', taskId: id }));
  ipcMain.handle('cloudhelm:delete-conversation', async (_event, id: string) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 120) throw new Error('Invalid conversation id');
    return lifecycle.delete(id, async () => {
      if (store?.get('conversation-cleanups', id)) {
        if (!await cleanup(id)) throw pendingCleanup();
        return;
      }
      // Authoritative state decides deletability before any runtime cleanup.
      state.assertDeletable(id);
      if (await runtime.call<boolean>({ method: 'has-task', taskId: id })) await runtime.call({ method: 'delete-task', taskId: id });
      state.deleteTask(id); // Rechecks state and commits the redo receipt before any filesystem removal.
      if (!await cleanup(id)) throw pendingCleanup();
    });
  });
}
