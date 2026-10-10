import type { MessageDocument } from '@cloudhelm/core';
import { PiReasoningStream, reasoningView } from './pi-reasoning.js';
import { modelThinking } from './model-catalog.js';
import type { ThinkingLevel, ThinkingView } from '@cloudhelm/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, SettingsManager,
  type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ConversationSession, SessionOptions, SessionProfile } from '@cloudhelm/core';
import { openSessionStorage } from './pi-session-storage.js';
import { installSessionModel, isolatedModelRuntime, resolveSessionModel } from './pi-session-model.js';
import { description, guidelines } from './pi-extensions/ask-user/prompts.js';
import askUser, { ASK_CHANNEL, type AskBridgeEvent } from './pi-extensions/ask-user/index.js';

/** One native Pi session, with CloudHelm's explicit tools, credentials and lifecycle limits. */
export async function createConversationSession(options: SessionOptions): Promise<ConversationSession> {
  const cwd = await mkdtemp(join(tmpdir(), 'cloudhelm-session-'));
  try {
    const manager = openSessionStorage(cwd, options.storage);
    const runtime = await isolatedModelRuntime(options.profile);
    const settings = SettingsManager.inMemory({ packages: [], retry: { enabled: false, provider: { maxRetries: 0 } },
      cacheWarming: 'off', compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 8000 } });
    const configureWindow = (model: { contextWindow: number }) => settings.applyOverrides({ compaction: {
      reserveTokens: Math.max(1, Math.min(8192, Math.floor(model.contextWindow * 0.25))),
      keepRecentTokens: Math.max(1, Math.min(8000, Math.floor(model.contextWindow * 0.25)))
    } });
    configureWindow(resolveSessionModel(options.profile).model);
    const bus = createEventBus();
    bus.on(ASK_CHANNEL, (data: unknown) => {
      const event = data as AskBridgeEvent;
      event.response = options.clarification.ask(event.toolCallId, event.questions, event.signal);
    });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: [options.systemPrompt, description, ...guidelines].join('\n'),
      extensionFactories: [{ name: '@cloudhelm/pi-ask-user', factory: askUser }, {
        name: '@cloudhelm/lifecycle', factory: (pi) => {
          pi.on('session_before_compact', (event) => {
            options.assertActive();
            // A retry can repeat operations with uncertain effects; only explicit user continuation may do so.
            if (event.willRetry) return { cancel: true };
            return undefined;
          });
        }
      }] });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error('CloudHelm Pi 扩展加载失败');
    const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime,
      model: resolveSessionModel(options.profile).model, thinkingLevel: options.thinkingLevel, settingsManager: settings,
      sessionManager: manager, resourceLoader: loader, noTools: 'builtin',
      tools: [...options.tools.map((tool) => tool.name), 'ask_user'],
      customTools: options.tools as unknown as ToolDefinition[] });
    if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
    const adapter = new PiConversationSession(session, options, cwd, async (profile) => {
      const { model } = await installSessionModel(runtime, profile);
      configureWindow(model);
      await session.setModel(model);
    });
    if (options.thinkingLevel !== undefined) adapter.setThinking(options.thinkingLevel);
    adapter.project();
    adapter.publishThinking();
    return adapter;
  } catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
}

class PiConversationSession implements ConversationSession {
  private readonly reasoningStream: PiReasoningStream;
  private preferred: ThinkingLevel;
  private selected: SessionProfile;
  private active: SessionProfile;
  private readonly pendingDocuments: Array<MessageDocument | undefined> = [];
  private readonly documents = new Map<string, MessageDocument>();
  private readonly projected = new Set<string>();
  private usageReady = false;
  private switched = false;
  private failure?: Error;
  private running?: Promise<void>;

  constructor(private readonly session: AgentSession, private readonly options: SessionOptions,
    private readonly cwd: string, private readonly applyModel: (profile: SessionProfile) => Promise<void>) {
    this.reasoningStream = new PiReasoningStream((value) => options.event({ type: 'reasoning-progress', value }));
    this.active = { ...options.profile };
    this.selected = this.active;
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'cloudhelm-message-document') {
        const saved = entry.data as { entryId: string; document: MessageDocument };
        this.documents.set(saved.entryId, saved.document);
      }
    }
    const saved = [...session.sessionManager.getBranch()].reverse().find((entry) => entry.type === 'custom' && entry.customType === 'cloudhelm-thinking');
    const value = saved?.type === 'custom' ? saved.data : undefined;
    this.preferred = options.thinkingLevel ?? (typeof value === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value as ThinkingLevel : session.thinkingLevel);
    session.setThinkingLevel(this.preferred);
    const previous = [...session.messages].reverse().find((message) => message.role === 'assistant');
    this.switched = !!previous && (previous.provider !== this.active.provider || previous.model !== this.active.modelId);
    const agent = session.agent;
    agent.toolExecution = 'parallel';
    const prepare = agent.prepareNextTurnWithContext;
    agent.prepareNextTurnWithContext = async (turn, signal) => {
      options.assertActive();
      await this.prepareModel();
      const result = await prepare?.(turn, signal);
      if (this.failure) throw this.failure;
      options.assertActive();
      return result;
    };
    const beforeTool = agent.beforeToolCall;
    agent.beforeToolCall = async (call, signal) => {
      options.assertActive();
      const asks = call.assistantMessage.content.filter((part) => part.type === 'toolCall'
        && ['ask_user', 'request_root_session'].includes(part.name));
      if (asks.length > 1 || (asks.length && (asks[0]?.type !== 'toolCall' || call.toolCall.name !== asks[0].name))) {
        return { block: true, reason: '需求澄清与 root 会话申请必须单独调用；等待回答后重新评估其他工具，禁止并行执行。' };
      }
      return beforeTool?.(call, signal);
    };
    const stream = agent.streamFunction;
    agent.streamFunction = (model, context, streamOptions) => {
      options.assertActive();
      if (this.failure) throw this.failure;
      const purpose = streamOptions?.sessionId === session.sessionManager.getSessionId() ? 'conversation' : 'compaction';
      options.beforeRequest(purpose, this.active);
      if (purpose === 'conversation') { this.usageReady = true; this.publishUsage(); }
      return stream(model, context, { ...streamOptions, apiKey: this.active.apiKey, env: {}, maxRetries: 0,
        maxTokens: purpose === 'conversation' ? Math.max(1, Math.min(8192, model.maxTokens, Math.floor(model.contextWindow * 0.25))) : streamOptions?.maxTokens });
    };
    // This listener runs after Pi's persistence listener. Public message_end runs before persistence.
    agent.subscribe(async (event) => {
      if ((event.type === 'message_start' || event.type === 'message_update') && event.message.role === 'assistant') {
        this.reasoningStream.update(event.message, this.session.thinkingLevel !== 'off');
      }
      if (event.type === 'tool_execution_start') options.event({ type: 'tool-start', id: event.toolCallId, name: event.toolName, args: event.args });
      if (event.type === 'tool_execution_end') options.event({ type: 'tool-end', id: event.toolCallId, name: event.toolName, isError: event.isError });
      if (event.type === 'message_end') {
        if (event.message.role === 'assistant') {
          const message = event.message;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            this.failure ??= new Error(message.errorMessage || '模型回复未完成');
          } else if (message.stopReason === 'length') {
            this.failure ??= new Error('模型输出达到长度上限，尚未给出完整操作或结论。请缩小问题、降低思考档位或切换模型后继续。');
          } else if (this.active === this.selected && message.provider === this.active.provider && message.model === this.active.modelId) this.switched = false;
          options.event({ type: 'response' });
        }
        this.project();
        if (event.message.role === 'assistant') this.reasoningStream.clear();
      }
      if (event.type === 'agent_end' && !this.failure) await this.prepareModel();
      if (event.type === 'turn_end') { options.event({ type: 'turn-end' }); this.publishUsage(); }
    });
    session.subscribe((event) => {
      if (event.type === 'compaction_start') {
        this.usageReady = false;
        this.publishUsage();
        options.event({ type: 'compaction', status: 'running' });
      }
      if (event.type === 'compaction_end') {
        this.usageReady = !!event.result;
        this.publishUsage();
        if (!event.result) {
          this.failure = new Error(event.errorMessage ?? '上下文压缩已停止，请检查后明确继续');
          // Never await abort from inside an active hook/listener.
          void session.abort();
        }
        options.event({ type: 'compaction', status: event.result ? 'complete' : 'failed', error: this.failure?.message });
      }
    });
  }

  get isStreaming(): boolean { return !!this.running || !this.session.isIdle; }
  get profile(): SessionProfile { return this.active; }
  select(profile: SessionProfile): void {
    resolveSessionModel(profile);
    this.selected = { ...profile };
    this.switched = true;
    this.usageReady = false;
    this.publishUsage();
    this.publishThinking();
  }
  setThinking(level: ThinkingLevel): void {
    if (!modelThinking(this.selected).levels.includes(level)) throw new Error('当前模型不支持此思考档位');
    this.session.sessionManager.appendCustomEntry('cloudhelm-thinking', level);
    this.preferred = level;
    if (!this.isStreaming && this.selected === this.active) this.session.setThinkingLevel(level);
    this.publishThinking();
  }
  publishThinking(): void {
    const selection = modelThinking(this.selected, this.preferred);
    const value: ThinkingView = { ...selection, effective: this.session.thinkingLevel,
      pending: this.selected !== this.active || selection.selected !== this.session.thinkingLevel };
    this.options.event({ type: 'thinking', value });
  }
  setReviewKey(jevKey?: string): void {
    const sameSelection = this.selected === this.active;
    this.active = { ...this.active, jevKey };
    this.selected = sameSelection ? this.active : { ...this.selected, jevKey };
  }
  private async prepareModel(): Promise<void> {
    if (this.selected !== this.active) {
      const selected = this.selected;
      await this.applyModel(selected);
      this.active = selected;
    }
    this.session.setThinkingLevel(this.preferred);
    this.publishThinking();
  }
  contextTokens(): number {
    return this.session.getContextUsage()?.tokens ?? Math.ceil(Buffer.byteLength(JSON.stringify(this.session.messages), 'utf8') / 2) + 4096;
  }
  prompt(text: string, document?: MessageDocument): Promise<void> {
    if (this.running) return Promise.reject(new Error('会话正在处理，请等待当前请求结束'));
    const run = this.runPrompt(text, document).finally(() => {
      if (this.running === run) this.running = undefined;
      this.reasoningStream.clear();
      this.options.event({ type: 'activity' });
    });
    this.running = run;
    this.options.event({ type: 'activity' });
    return run;
  }
  private async runPrompt(text: string, document?: MessageDocument): Promise<void> {
    this.failure = undefined;
    this.options.assertActive();
    await this.prepareModel();
    this.options.assertActive();
    this.pendingDocuments.push(document);
    await this.session.prompt(text, { expandPromptTemplates: false });
    this.project();
    this.publishUsage();
    if (this.failure) throw this.failure;
  }
  async steer(text: string, document?: MessageDocument): Promise<void> { this.pendingDocuments.push(document); await this.session.steer(text); }
  async context(text: string): Promise<void> {
    await this.session.sendCustomMessage({ customType: 'cloudhelm-control', content: text, display: false }, { triggerTurn: false });
  }
  abort(): Promise<void> { return this.session.abort(); }
  async waitForIdle(): Promise<void> {
    await this.running?.catch(() => {});
    await this.session.waitForIdle();
  }
  clearQueue(): void { this.session.clearQueue(); this.pendingDocuments.length = 0; }
  dispose(): void {
    this.reasoningStream.clear();
    this.session.dispose();
    void rm(this.cwd, { recursive: true, force: true });
  }

  project(): void {
    for (const entry of this.session.sessionManager.getBranch()) {
      if (this.projected.has(entry.id) || entry.type !== 'message') continue;
      this.projected.add(entry.id);
      const message = entry.message;
      if (message.role === 'toolResult' && message.toolName === 'ask_user' && !message.isError) {
        const answer = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        this.options.event({ type: 'text', value: { entryId: entry.id, role: 'user',
          text: `[需求澄清回答]\n${answer}`, createdAt: message.timestamp } });
      }
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      if (message.role === 'user' && !this.documents.has(entry.id) && this.pendingDocuments.length) {
        const document = this.pendingDocuments.shift();
        if (document) {
          this.documents.set(entry.id, document);
          this.session.sessionManager.appendCustomEntry('cloudhelm-message-document', { entryId: entry.id, document });
        }
      }
      const document = this.documents.get(entry.id);
      const text = typeof message.content === 'string' ? message.content
        : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
      const reasoning = message.role === 'assistant' ? reasoningView(message) : undefined;
      if (text || reasoning) this.options.event({ type: 'text', value: { entryId: entry.id, reasoning, document,
        role: message.role === 'assistant' ? 'agent' : 'user', text: document ? document.parts.map((part) => part.type === 'text' ? part.text : part.reference.kind === 'terminal' ? '[Terminal]' : '[粘贴文本]').join('') : text, createdAt: message.timestamp,
        model: message.role === 'assistant' ? { provider: message.provider, modelId: message.model } : undefined } });
    }
  }
  private publishUsage(): void {
    const usage = this.usageReady && !this.switched ? this.session.getContextUsage() : undefined;
    const last = this.session.messages.at(-1);
    const provider = last?.role === 'assistant' && !['error', 'aborted'].includes(last.stopReason)
      && last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite > 0;
    this.options.event({ type: 'usage', value: {
      model: { provider: this.selected.provider, modelId: this.selected.modelId },
      usedTokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null,
      source: usage?.tokens == null ? 'unknown' : provider ? 'provider' : 'estimate', updatedAt: Date.now()
    } });
  }
}
