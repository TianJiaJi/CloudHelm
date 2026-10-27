import { createHash, randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { redactOutput } from '@cloudhelm/core';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { ConversationStart, MessageDocument, MessagePart, ReferenceBody, StructuredSend, TaskView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import type { PreparedContext } from '@cloudhelm/contracts/runtime';
import type { ReferenceStore } from './reference-store.js';

interface Dependencies {
  state: AppState; store: SqliteStore; runtime: RuntimeBridge; references: ReferenceStore;
  start(input: ConversationStart, document?: MessageDocument, initialMessage?: string, intent?: string, assertPrepared?: (scopes: import('@cloudhelm/contracts').LocalScope[]) => void): Promise<TaskView>;
  send(id: string, text: string, tokens: string[], document?: MessageDocument, intent?: string, prepared?: PreparedContext): Promise<void>;
  previewSelections?(tokens: string[]): import('@cloudhelm/contracts').LocalScope[];
  ensureRuntime?(task: TaskView): Promise<void>;
}
interface Receipt { fingerprint: string; state: 'preparing' | 'dispatching' | 'sent' | 'failed'; conversationId?: string }
interface PreparationJob { canceled: boolean; dispatching: boolean; taskId?: string; allowCompaction?: boolean; current?: () => boolean; promise: Promise<{ conversationId: string }> }
export function registerStructuredMessageIpc({ state, store, runtime, references, start, send, ensureRuntime, previewSelections }: Dependencies): void {
  const active = new Map<string, PreparationJob>();
  state.setBudgetPreparationAuthority((id, taskId) => {
    const job = active.get(id);
    return !!job && !job.canceled && !job.dispatching && job.current?.() === true
      && (taskId === undefined || (job.taskId === taskId && job.allowCompaction === true));
  }, () => {
    for (const [id, job] of active) {
      if (job.canceled || job.dispatching || !job.current) continue;
      let valid = false;
      try { valid = job.current(); } catch { /* Missing credentials/authority revokes the capability. */ }
      if (valid) continue;
      job.canceled = true;
      // Revoke synchronously in Main; ordered IPC cancels the existing Worker
      // controller before a later acknowledgment can unblock HTTP dispatch.
      void runtime.call({ method: 'cancel-message', requestId: id }).catch(() => {});
    }
  });
  ipcMain.handle('cloudhelm:quote-terminal', (_event, input) => references.quote(input));
  ipcMain.handle('cloudhelm:read-reference', (_event, id: string) => references.read(id));
  ipcMain.handle('cloudhelm:cancel-message', async (_event, id: string) => {
    const job = active.get(id);
    if (!job) return;
    if (job.dispatching) throw new Error('消息已交付，不能取消发送准备');
    job.canceled = true;
    await runtime.call({ method: 'cancel-message', requestId: id });
  });
  ipcMain.handle('cloudhelm:send-structured', (_event, input: StructuredSend) => {
    const id = input?.document?.requestId;
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/u.test(id) || !Array.isArray(input.document.parts) || !input.document.parts.length || input.document.parts.length > 1000) throw new Error('无效消息');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = store.get<Receipt>('message-receipts', id);
    if (old && old.fingerprint !== fingerprint) throw new Error('发送标识已绑定其他内容，请重新发送');
    if (old?.state === 'sent' && old.conversationId) return { conversationId: old.conversationId };
    const pending = active.get(id);
    if (pending) return pending.promise;
    if (old?.state === 'dispatching') {
      const delivered = state.snapshot().messages.find((message) => message.document?.requestId === id);
      if (delivered) return { conversationId: delivered.taskId };
      throw new Error('上次发送结果尚未确定，请检查对话记录；不会自动重放');
    }
    if (input.conversationId && [...active.values()].some((job) => job.taskId === input.conversationId)) throw new Error('该对话已有消息正在准备或投递');
    const job: PreparationJob = { canceled: false, dispatching: false, taskId: input.conversationId, promise: Promise.resolve({ conversationId: '' }) };
    job.promise = run(input, fingerprint, job).finally(() => active.delete(id));
    active.set(id, job); return job.promise;
  });

  async function run(input: StructuredSend, fingerprint: string, job: PreparationJob) {
    const id = input.document.requestId;
    const receipt: Receipt = { fingerprint, state: 'preparing', conversationId: input.conversationId };
    store.put('message-receipts', id, receipt);
    try {
      const task = input.conversationId ? state.getTask(input.conversationId) : undefined;
      const hostId = task?.hostIds[0] ?? input.hostId;
      if (task && (task.hostIds.length > 1 || (task.hostIds[0] ?? null) !== input.hostId)) throw new Error('目标主机与对话不一致');
      if (task && ensureRuntime) await ensureRuntime(task);
      if (job.canceled) throw new Error('已取消发送，草稿已保留');
      const profile = structuredClone(task ? state.conversationProfile(task) : state.runtimeProfile(input.model));
      const hosts = hostId ? [structuredClone(state.getHost(hostId))] : [];
      const hostBinding = (values: typeof hosts) => JSON.stringify(values.map((host) => ({ ...host, status: undefined, fingerprint: undefined })));
      const boundHosts = hostBinding(hosts);
      const controlBinding = () => {
        if (!task) return '';
        const current = state.getTask(task.id);
        return JSON.stringify([current.reviewRevision, current.reviewModesByHost, current.hostIds, current.localScopes,
          current.thinking?.selected, state.runtimeReviewerForLiveTask(current)]);
      };
      const boundControl = controlBinding();
      // Bind every auxiliary attempt to this existing preparation, not a new
      // allowance or silently substituted provider/credential configuration.
      job.current = () => {
        const current = task ? state.conversationProfile(state.getTask(task.id)) : state.runtimeProfile(input.model);
        return controlBinding() === boundControl && hostBinding(hostId ? [state.getHost(hostId)] : []) === boundHosts && current.provider === profile.provider && current.modelId === profile.modelId
          && current.credentialRevision === profile.credentialRevision && current.baseUrl === profile.baseUrl
          && current.apiKey === profile.apiKey && current.contextWindow === profile.contextWindow && current.maxTokens === profile.maxTokens;
      };
      const bodies: ReferenceBody[] = [];
      const parts: MessagePart[] = input.document.parts.map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: redactOutput(part.text) };
        if (part.type !== 'reference' || !part.reference) throw new Error('无效消息片段');
        let body: ReferenceBody;
        if (part.reference.kind === 'paste' && typeof part.content === 'string') {
          body = { reference: { id: randomUUID(), kind: 'paste', capturedAt: Date.now() }, original: redactOutput(part.content) };
        } else body = references.read(part.reference.id);
        if (body.reference.kind === 'terminal' && body.reference.hostId !== hostId) throw new Error('终端引用与目标主机不一致');
        // A new immutable instance keeps summaries scoped to this message and model.
        body = { reference: { ...body.reference, id: randomUUID(), summarized: false }, original: body.original };
        bodies.push(body);
        return { type: 'reference', instanceId: part.instanceId ?? part.reference.id, reference: body.reference };
      });
      if (!parts.some((part) => part.type === 'reference' || part.text.trim())) throw new Error('请输入消息');
      const document: MessageDocument = { requestId: id, parts };
      if (task) {
        // Genuine input owns its candidate round before any history compaction.
        // The durable pending-input marker prevents the old answer closing it.
        state.requestBudgets.input(task.id, id);
        const execution = state.snapshot().execution?.[task.id];
        job.taskId = task.id;
        job.allowCompaction = execution?.model === 'idle' && execution.remote === 'idle' && !execution.stopping;
      }
      if (input.localSelectionTokens.length && !previewSelections) throw new Error('本地资料授权预览不可用');
      const scopes = previewSelections?.(input.localSelectionTokens) ?? [];
      const prepared = await runtime.call<{ text: string; intent?: string; bodies: ReferenceBody[]; document: MessageDocument; preparedContext?: PreparedContext }>({ method: 'prepare-message',
        requestId: id, taskId: task?.id, document, bodies, profile, localScopes: scopes, hosts });
      if (job.canceled) throw new Error('已取消发送，草稿已保留');
      if (!job.current()) throw new Error('模型已变化，请重新发送以核对容量');
      if (task && (!prepared?.preparedContext?.revision || !prepared.preparedContext.beforeRevision)) throw new Error('准备版本确认不可用，消息未投递');
      for (const body of prepared.bodies) references.save(body);
      job.dispatching = true;
      receipt.state = 'dispatching'; store.put('message-receipts', id, receipt);
      let conversationId = input.conversationId;
      if (conversationId) await send(conversationId, prepared.text, input.localSelectionTokens, prepared.document, prepared.intent, prepared.preparedContext);
      else {
        const title = parts.filter((part) => part.type === 'text').map((part) => part.text).join('').trim().slice(0, 200) ||
          (bodies.some((body) => body.reference.kind === 'terminal') ? '请分析这段终端输出' : '分析粘贴内容');
        const created = await start({ hostId: input.hostId, message: title, model: input.model,
          thinkingLevel: input.thinkingLevel, localSelectionTokens: input.localSelectionTokens }, prepared.document, prepared.text, prepared.intent, (currentScopes) => {
          if (job.canceled || !job.current?.() || JSON.stringify(currentScopes) !== JSON.stringify(scopes)) throw new Error('发送准备绑定已变化，草稿已保留');
        });
        conversationId = created.id;
      }
      store.put('message-receipts', id, { fingerprint, state: 'sent', conversationId });
      return { conversationId };
    } catch (error) {
      if (!job.dispatching || (error instanceof Error && !/timed out|运行进程|runtime stopped/iu.test(error.message))) store.put('message-receipts', id, { ...receipt, state: 'failed' });
      throw error;
    }
  }
}
