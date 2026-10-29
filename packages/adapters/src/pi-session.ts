import type { IdleCompactionLease, MessageDocument, ModelRequestAttempt } from '@cloudhelm/core';
import { sessionContextSnapshot } from './pi-context-budget.js';
import { PiReasoningStream, reasoningView } from './pi-reasoning.js';
import { modelCapacity, modelThinking } from './model-catalog.js';
import { conversationOutputTokens } from './model-capacity.js';
import { meterModelRequest } from './model-request-meter.js';
import type { ThinkingLevel, ThinkingView } from '@cloudhelm/core';
import { mkdtemp } from 'node:fs/promises';
import { sessionDirectoryCleanup } from './session-directory-cleanup.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, SettingsManager,
  type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ConversationSession, SessionOptions, SessionProfile } from '@cloudhelm/core';
import { openSessionStorage } from './pi-session-storage.js';
import { installSessionModel, isolatedModelRuntime, resolveSessionModel } from './pi-session-model.js';
import { description, guidelines } from './pi-extensions/ask-user/prompts.js';
import askUser, { ASK_CHANNEL, type AskBridgeEvent } from './pi-extensions/ask-user/index.js';

const conversationSystemPrompt = (prompt: string) => [prompt, description, ...guidelines].join('\n');
interface ActiveCompaction {
  lease: IdleCompactionLease; controller: AbortController; selected: SessionProfile;
  generation: string | undefined; contextRevision: string;
}

/** One native Pi session, with CloudHelm's explicit tools, credentials and lifecycle limits. */
export async function createConversationSession(options: SessionOptions): Promise<ConversationSession> {
  const cwd = await mkdtemp(join(tmpdir(), 'cloudhelm-session-'));
  const cleanupDirectory = sessionDirectoryCleanup(cwd);
  try {
    const manager = openSessionStorage(cwd, options.storage);
    const runtime = await isolatedModelRuntime(options.profile);
    const settings = SettingsManager.inMemory({ packages: [], retry: { enabled: false, provider: { maxRetries: 0 } },
      cacheWarming: 'off', compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 8000 } });
    const configureWindow = (model: { contextWindow: number; maxTokens: number }) => settings.applyOverrides({ compaction: {
      reserveTokens: conversationOutputTokens(model),
      keepRecentTokens: Math.max(1, Math.min(8000, Math.floor(model.contextWindow * 0.25)))
    } });
    configureWindow(resolveSessionModel(options.profile).model);
    const bus = createEventBus();
    bus.on(ASK_CHANNEL, (data: unknown) => {
      const event = data as AskBridgeEvent;
      event.response = options.clarification.ask(event.toolCallId, event.questions, event.signal);
    });
    let assertCompactionActive = () => options.assertActive();
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: conversationSystemPrompt(options.systemPrompt),
      extensionFactories: [{ name: '@cloudhelm/pi-ask-user', factory: askUser }, {
        name: '@cloudhelm/lifecycle', factory: (pi) => {
          pi.on('session_before_compact', (event) => {
            assertCompactionActive();
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
    const adapter = new PiConversationSession(session, options, cleanupDirectory, async (profile) => {
      const { model } = await installSessionModel(runtime, profile);
      configureWindow(model);
      await session.setModel(model);
    });
    assertCompactionActive = () => adapter.assertCompactionActive();
    if (options.thinkingLevel !== undefined) adapter.setThinking(options.thinkingLevel);
    adapter.project();
    adapter.publishThinking();
    return adapter;
  } catch (error) { await cleanupDirectory(); throw error; }
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
  private answered = false;
  private running?: Promise<void>;
  private compacting?: Promise<void>;
  private idleCompaction?: ActiveCompaction;
  private previousFrameTokens?: number;
  private controlRevision = 0;
  private responseAttempt?: ModelRequestAttempt;
  private disposed = false;

  constructor(private readonly session: AgentSession, private readonly options: SessionOptions,
    private readonly cleanupDirectory: ReturnType<typeof sessionDirectoryCleanup>,
    private readonly applyModel: (profile: SessionProfile) => Promise<void>) {
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
    agent.toolExecution = 'sequential'; // one tool call at a time: remote review/execution must never overlap
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
    agent.streamFunction = async (model, context, streamOptions) => {
      streamOptions?.signal?.throwIfAborted();
      const purpose = streamOptions?.sessionId === session.sessionManager.getSessionId() ? 'conversation' : 'compaction';
      const preparation = purpose === 'compaction' ? this.idleCompaction : undefined;
      const assertRequest = () => {
        if (preparation) {
          this.assertIdleLease(preparation);
          if (this.contextSnapshot().revision !== preparation.contextRevision) throw new Error('准备期间活动上下文已变化');
        } else options.assertActive();
      };
      assertRequest();
      if (this.failure) throw this.failure;
      let requestContext = context;
      if (purpose === 'conversation' && options.currentSystemPrompt) {
        const leading = context.messages[0];
        if (leading?.role !== 'system' || leading.content !== '' || typeof leading.sections?.preamble !== 'string') {
          throw new Error('CloudHelm system authorization projection unavailable');
        }
        // Pi stores custom prompts in the preamble section; changing content would duplicate the prompt.
        const current = conversationSystemPrompt(options.currentSystemPrompt());
        if (!current.trim()) throw new Error('CloudHelm system authorization projection is empty');
        requestContext = { ...context, messages: context.messages.map((message) => message.role === 'system'
          && typeof message.sections?.preamble === 'string'
          ? { ...message, sections: { ...message.sections, preamble: current } } : message) };
      }
      const profile = this.active;
      const selected = this.selected;
      const generation = this.generation();
      const meter = meterModelRequest({ api: model.api, purpose, transport: streamOptions?.transport,
        signal: preparation ? AbortSignal.any([preparation.controller.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])]) : streamOptions?.signal,
        fetch: streamOptions?.fetch, assertActive: () => {
          assertRequest();
          if (selected !== this.selected || generation !== this.generation()) throw new Error('模型或任务策略已变更，已停止请求重试。');
        },
        failed: (error) => { this.failure ??= error instanceof Error ? error : new Error('Model request reservation failed'); },
        reserve: async (attempt, signal) => {
          if (preparation) await preparation.lease.reserve(profile, attempt, signal);
          else await options.beforeRequest(purpose, profile, attempt, signal);
          if (purpose === 'conversation') { this.responseAttempt = { ...attempt }; this.previousFrameTokens = this.contextSnapshot().frameTokens; this.usageReady = true; this.publishUsage(); }
        } });
      await meter.beforeStream();
      return stream(model, requestContext, { ...streamOptions, ...(meter.fetch ? { fetch: meter.fetch } : {}),
        apiKey: profile.apiKey, env: {}, maxRetries: 0,
        maxTokens: purpose === 'conversation' ? conversationOutputTokens(model) : streamOptions?.maxTokens });
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
          this.answered = message.stopReason === 'stop' && message.content.some((part) => part.type === 'text' && !!part.text.trim());
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            this.failure ??= new Error(message.errorMessage || '模型回复未完成');
          } else if (message.stopReason === 'length') {
            this.failure ??= new Error('模型输出达到长度上限，尚未给出完整操作或结论。请缩小问题、降低思考档位或切换模型后继续。');
          } else if (this.active === this.selected && message.provider === this.active.provider && message.model === this.active.modelId) this.switched = false;
          const attempt = this.responseAttempt; this.responseAttempt = undefined;
          if (attempt) options.event({ type: 'response', attempt, status: message.stopReason });
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
        this.previousFrameTokens = undefined;
        this.publishUsage();
        options.event({ type: 'compaction', status: 'running' });
      }
      if (event.type === 'compaction_end') {
        this.usageReady = !!event.result;
        this.publishUsage();
        if (!event.result) {
          this.failure ??= new Error(event.errorMessage ?? '上下文压缩已停止，请检查后明确继续');
          // Never await abort from inside an active hook/listener.
          void session.abort();
        }
        options.event({ type: 'compaction', status: event.result ? 'complete' : 'failed', error: this.failure?.message });
      }
    });
  }

  get isStreaming(): boolean { return !!this.running || !!this.compacting || !!this.idleCompaction || !this.session.isIdle; }
  get lastTurnAnswered(): boolean { return this.answered; }
  get profile(): SessionProfile { return this.active; }
  select(profile: SessionProfile): void {
    resolveSessionModel(profile);
    this.controlRevision++;
    this.invalidateCompaction();
    this.previousFrameTokens = undefined;
    this.selected = { ...profile };
    this.switched = true;
    this.usageReady = false;
    this.publishUsage();
    this.publishThinking();
  }
  setThinking(level: ThinkingLevel): void {
    if (!modelThinking(this.selected).levels.includes(level)) throw new Error('当前模型不支持此思考档位');
    this.controlRevision++;
    this.invalidateCompaction();
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
    this.controlRevision++;
    this.invalidateCompaction();
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
  private generation(): string { return JSON.stringify([this.controlRevision, this.options.requestGeneration?.()]); }
  contextSnapshot(systemPrompt?: string) {
    return sessionContextSnapshot(this.session, this.selected, conversationSystemPrompt(this.options.systemPrompt),
      conversationSystemPrompt(systemPrompt ?? this.options.currentSystemPrompt?.() ?? this.options.systemPrompt), !this.switched,
      this.previousFrameTokens, this.generation());
  }
  contextTokens(): number { return this.contextSnapshot().budget.usedTokens; }

  /** Called by the lifecycle hook, which cannot grant normal conversation/tool access. */
  assertCompactionActive(): void {
    if (this.idleCompaction) this.assertIdleLease(this.idleCompaction);
    else this.options.assertActive();
  }
  private assertIdleLease(active: ActiveCompaction): void {
    active.controller.signal.throwIfAborted(); active.lease.signal.throwIfAborted(); active.lease.assertValid();
    if (this.idleCompaction !== active || this.selected !== active.selected || this.generation() !== active.generation)
      throw new Error('发送准备租约已失效');
  }
  private invalidateCompaction(): void {
    if (this.idleCompaction) { this.idleCompaction.controller.abort(); this.session.abortCompaction(); }
  }
  async compactIdle(lease: IdleCompactionLease): Promise<void> {
    if (this.isStreaming) return Promise.reject(new Error('会话尚未空闲，不能整理上下文'));
    lease.signal.throwIfAborted(); lease.assertValid();
    const active: ActiveCompaction = { lease, controller: new AbortController(), selected: this.selected,
      generation: this.generation(), contextRevision: this.contextSnapshot().revision };
    this.idleCompaction = active;
    const abort = () => { active.controller.abort(); this.session.abortCompaction(); };
    lease.signal.addEventListener('abort', abort, { once: true });
    const run = this.runIdleCompaction(active).finally(() => {
      lease.signal.removeEventListener('abort', abort);
      if (this.idleCompaction === active) this.idleCompaction = undefined;
      if (this.compacting === run) this.compacting = undefined;
      this.options.event({ type: 'activity' });
    });
    this.compacting = run; this.options.event({ type: 'activity' });
    return run;
  }
  private async runIdleCompaction(active: ActiveCompaction): Promise<void> {
    this.failure = undefined;
    try {
      await this.prepareModel(); this.assertIdleLease(active);
      // Native compact starts by aborting the agent: check again after every
      // asynchronous preparation and hold exclusive access until it settles.
      if (this.running || !this.session.isIdle || this.contextSnapshot().revision !== active.contextRevision)
        throw new Error('活动上下文已变化，不能整理');
      await this.session.compact();
      this.assertIdleLease(active);
      if (this.failure) throw this.failure;
      this.publishUsage();
    } catch (error) { throw this.failure ?? error; }
  }
  prompt(text: string, document?: MessageDocument): Promise<void> {
    return this.runTurn(async () => {
      this.pendingDocuments.push(document);
      await this.session.prompt(text, { expandPromptTemplates: false });
    });
  }
  resumeWithContext(text: string): Promise<void> {
    return this.runTurn(() => this.session.sendCustomMessage({ customType: 'cloudhelm-control', content: text, display: false }, { triggerTurn: true }));
  }
  private runTurn(start: () => Promise<void>): Promise<void> {
    if (this.isStreaming) return Promise.reject(new Error('会话正在处理，请等待当前请求结束'));
    this.controlRevision++;
    const run = this.executeTurn(start).finally(() => {
      if (this.running === run) this.running = undefined;
      this.reasoningStream.clear();
      this.options.event({ type: 'activity' });
    });
    this.running = run;
    this.options.event({ type: 'activity' });
    return run;
  }
  private async executeTurn(start: () => Promise<void>): Promise<void> {
    this.responseAttempt = undefined;
    this.failure = undefined;
    this.answered = false;
    this.options.assertActive();
    await this.prepareModel();
    this.options.assertActive();
    try {
      await start();
      await this.session.waitForIdle();
    } catch (error) {
      // Provider/compaction wrappers may replace a rejected reservation with a
      // generic connection error. Preserve the earlier authoritative failure.
      throw this.failure ?? error;
    }
    this.project();
    this.publishUsage();
    if (this.failure) throw this.failure;
  }
  async steer(text: string, document?: MessageDocument): Promise<void> {
    this.controlRevision++;
    if (this.idleCompaction) { this.invalidateCompaction(); throw new Error('上下文正在整理，消息未投递，请重新发送'); }
    this.pendingDocuments.push(document); await this.session.steer(text);
  }
  async context(text: string): Promise<void> {
    this.controlRevision++;
    if (this.idleCompaction) { this.invalidateCompaction(); throw new Error('整理期间上下文发生变化'); }
    await this.session.sendCustomMessage({ customType: 'cloudhelm-control', content: text, display: false }, { triggerTurn: false });
  }
  abort(): Promise<void> { this.responseAttempt = undefined; this.controlRevision++; this.invalidateCompaction(); return this.session.abort(); }
  async waitForIdle(): Promise<void> {
    await this.compacting?.catch(() => {});
    await this.running?.catch(() => {});
    await this.session.waitForIdle();
  }
  clearQueue(): void { this.controlRevision++; this.invalidateCompaction(); this.session.clearQueue(); this.pendingDocuments.length = 0; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.invalidateCompaction();
      this.reasoningStream.clear();
      this.session.dispose();
    } finally { void this.cleanupDirectory(); }
  }

  project(): void {
    for (const entry of this.session.sessionManager.getBranch()) {
      if (this.projected.has(entry.id) || entry.type !== 'message') continue;
      this.projected.add(entry.id);
      const message = entry.message;
      if (message.role === 'toolResult' && message.toolName === 'ask_user' && !message.isError) {
        const answer = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        this.options.event({ type: 'text', value: { entryId: entry.id, role: 'user', source: 'clarification',
          clarificationToolCallId: message.toolCallId, text: `[需求澄清回答]\n${answer}`, createdAt: message.timestamp } });
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
        role: message.role === 'assistant' ? 'agent' : 'user', source: message.role === 'assistant' ? 'assistant' : 'input', text: document ? document.parts.map((part) => part.type === 'text' ? part.text : part.reference.kind === 'terminal' ? '[Terminal]' : '[粘贴文本]').join('') : text, createdAt: message.timestamp,
        model: message.role === 'assistant' ? { provider: message.provider, modelId: message.model } : undefined } });
    }
  }
  private publishUsage(): void {
    const usage = this.usageReady && !this.switched ? this.session.getContextUsage() : undefined;
    const last = this.session.messages.at(-1);
    const provider = last?.role === 'assistant' && !['error', 'aborted'].includes(last.stopReason)
      && last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite > 0;
    this.options.event({ type: 'usage', value: {
      budget: this.contextSnapshot().budget, capacity: modelCapacity(this.selected),
      model: { provider: this.selected.provider, modelId: this.selected.modelId },
      usedTokens: usage?.tokens ?? null, contextWindow: usage?.contextWindow ?? null,
      source: usage?.tokens == null ? 'unknown' : provider ? 'provider' : 'estimate', updatedAt: Date.now()
    } });
  }
}
