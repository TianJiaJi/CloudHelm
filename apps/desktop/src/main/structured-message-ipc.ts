import { createHash, randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { redactOutput } from '@cloudhelm/core';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { ConversationStart, MessageDocument, MessagePart, ReferenceBody, StructuredSend, TaskView } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';
import type { RuntimeBridge } from './runtime-bridge.js';
import type { ReferenceStore } from './reference-store.js';

interface Dependencies {
  state: AppState; store: SqliteStore; runtime: RuntimeBridge; references: ReferenceStore;
  start(input: ConversationStart, document?: MessageDocument, initialMessage?: string, intent?: string): Promise<TaskView>;
  send(id: string, text: string, tokens: string[], document?: MessageDocument, intent?: string): Promise<void>;
  ensureRuntime?(task: TaskView): Promise<void>;
}
interface Receipt { fingerprint: string; state: 'preparing' | 'dispatching' | 'sent' | 'failed'; conversationId?: string }
export function registerStructuredMessageIpc({ state, store, runtime, references, start, send, ensureRuntime }: Dependencies): void {
  const active = new Map<string, { canceled: boolean; dispatching: boolean; promise: Promise<{ conversationId: string }> }>();
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
    const job = { canceled: false, dispatching: false, promise: Promise.resolve({ conversationId: '' }) };
    job.promise = run(input, fingerprint, job).finally(() => active.delete(id));
    active.set(id, job); return job.promise;
  });

  async function run(input: StructuredSend, fingerprint: string, job: { canceled: boolean; dispatching: boolean }) {
    const id = input.document.requestId;
    const receipt: Receipt = { fingerprint, state: 'preparing', conversationId: input.conversationId };
    store.put('message-receipts', id, receipt);
    try {
      const task = input.conversationId ? state.getTask(input.conversationId) : undefined;
      const hostId = task?.hostIds[0] ?? input.hostId;
      if (task && (task.hostIds.length > 1 || (task.hostIds[0] ?? null) !== input.hostId)) throw new Error('目标主机与对话不一致');
      if (task && ensureRuntime) await ensureRuntime(task);
      if (job.canceled) throw new Error('已取消发送，草稿已保留');
      const profile = task ? state.conversationProfile(task) : state.runtimeProfile(input.model);
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
      const usage = task ? state.snapshot().contextUsage?.[task.id] : undefined;
      const prepared = await runtime.call<{ text: string; intent?: string; bodies: ReferenceBody[]; document: MessageDocument }>({ method: 'prepare-message',
        requestId: id, taskId: task?.id, document, bodies, profile, usedTokens: usage?.usedTokens ?? 4096 });
      if (job.canceled) throw new Error('已取消发送，草稿已保留');
      const current = task ? state.conversationProfile(state.getTask(task.id)) : state.runtimeProfile(input.model);
      if (current.provider !== profile.provider || current.modelId !== profile.modelId || current.credentialRevision !== profile.credentialRevision) throw new Error('模型已变化，请重新发送以核对容量');
      for (const body of prepared.bodies) references.save(body);
      job.dispatching = true;
      receipt.state = 'dispatching'; store.put('message-receipts', id, receipt);
      let conversationId = input.conversationId;
      if (conversationId) await send(conversationId, prepared.text, input.localSelectionTokens, prepared.document, prepared.intent);
      else {
        const title = parts.filter((part) => part.type === 'text').map((part) => part.text).join('').trim().slice(0, 200) ||
          (bodies.some((body) => body.reference.kind === 'terminal') ? '请分析这段终端输出' : '分析粘贴内容');
        const created = await start({ hostId: input.hostId, message: title, model: input.model,
          thinkingLevel: input.thinkingLevel, localSelectionTokens: input.localSelectionTokens }, prepared.document, prepared.text, prepared.intent);
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
