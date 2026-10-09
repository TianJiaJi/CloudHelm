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
      model: resolveSessionModel(options.profile).model, thinkingLevel: 'off', settingsManager: settings,
      sessionManager: manager, resourceLoader: loader, noTools: 'builtin',
      tools: [...options.tools.map((tool) => tool.name), 'ask_user'],
      customTools: options.tools as unknown as ToolDefinition[] });
    if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
    const adapter = new PiConversationSession(session, options, cwd, async (profile) => {
      const { model } = await installSessionModel(runtime, profile);
      configureWindow(model);
      await session.setModel(model);
    });
    adapter.project();
    return adapter;
  } catch (error) { await rm(cwd, { recursive: true, force: true }); throw error; }
}

class PiConversationSession implements ConversationSession {
  private selected: SessionProfile;
  private active: SessionProfile;
  private readonly projected = new Set<string>();
  private usageReady = false;
  private switched = false;
  private failure?: Error;
  private running?: Promise<void>;

  constructor(private readonly session: AgentSession, private readonly options: SessionOptions,
    private readonly cwd: string, private readonly applyModel: (profile: SessionProfile) => Promise<void>) {
    this.active = { ...options.profile };
    this.selected = this.active;
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
      if (event.type === 'tool_execution_start') options.event({ type: 'tool-start', id: event.toolCallId, name: event.toolName, args: event.args });
      if (event.type === 'tool_execution_end') options.event({ type: 'tool-end', id: event.toolCallId, name: event.toolName, isError: event.isError });
      if (event.type === 'message_end') {
        if (event.message.role === 'assistant') {
          const message = event.message;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            this.failure ??= new Error(message.errorMessage || '模型回复未完成');
          } else if (this.active === this.selected && message.provider === this.active.provider && message.model === this.active.modelId) this.switched = false;
          options.event({ type: 'response' });
        }
        this.project();
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
  }
  setReviewKey(jevKey?: string): void {
    const sameSelection = this.selected === this.active;
    this.active = { ...this.active, jevKey };
    this.selected = sameSelection ? this.active : { ...this.selected, jevKey };
  }
  private async prepareModel(): Promise<void> {
    if (this.selected === this.active) return;
    const selected = this.selected;
    await this.applyModel(selected);
    this.active = selected;
  }
  prompt(text: string): Promise<void> {
    if (this.running) return Promise.reject(new Error('会话正在处理，请等待当前请求结束'));
    const run = this.runPrompt(text).finally(() => { if (this.running === run) this.running = undefined; });
    this.running = run;
    return run;
  }
  private async runPrompt(text: string): Promise<void> {
    this.failure = undefined;
    this.options.assertActive();
    await this.prepareModel();
    this.options.assertActive();
    await this.session.prompt(text, { expandPromptTemplates: false });
    this.project();
    this.publishUsage();
    if (this.failure) throw this.failure;
  }
  async steer(text: string): Promise<void> { await this.session.steer(text); }
  async context(text: string): Promise<void> {
    await this.session.sendCustomMessage({ customType: 'cloudhelm-control', content: text, display: false }, { triggerTurn: false });
  }
  abort(): Promise<void> { return this.session.abort(); }
  async waitForIdle(): Promise<void> {
    await this.running?.catch(() => {});
    await this.session.waitForIdle();
  }
  clearQueue(): void { this.session.clearQueue(); }
  dispose(): void {
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
      const text = typeof message.content === 'string' ? message.content
        : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
      if (text) this.options.event({ type: 'text', value: { entryId: entry.id,
        role: message.role === 'assistant' ? 'agent' : 'user', text, createdAt: message.timestamp,
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
