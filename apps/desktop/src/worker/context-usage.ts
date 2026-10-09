import type { Message, TranscriptContext } from '@earendil-works/pi-ai';
import { piContextUsage } from '@cloudhelm/adapters';
import type { ContextUsageView, ModelChoice } from '@cloudhelm/contracts';

/** Tracks the actual transformed request, never the uncompressed Agent history. */
export class ContextUsageTracker {
  private messages: Message[] = [];
  private model?: ModelChoice;
  private request = 0;
  private contextWindow: number | null = null;
  private stale = true;
  private discardUsage = true;
  constructor(private readonly emit: (value: ContextUsageView) => void) {}

  invalidate(model: ModelChoice): void {
    this.stale = true;
    this.discardUsage = true;
    this.emit({ model, request: this.request, usedTokens: null, contextWindow: null, source: 'unknown', updatedAt: Date.now() });
  }

  begin(context: Pick<TranscriptContext, 'messages'>, model: ModelChoice, contextWindow: number, request: number, compacted: boolean): void {
    const changed = this.model?.provider !== model.provider || this.model?.modelId !== model.modelId;
    this.discardUsage ||= compacted || changed;
    this.model = model;
    this.contextWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
    this.request = request;
    this.messages = [...context.messages];
    this.stale = false;
    this.publish();
  }

  complete(message: Message): void {
    if (this.stale || message.role !== 'assistant') return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    // Old usage may describe a larger pre-compaction prefix. Clear it before adding fresh usage.
    if (this.discardUsage) this.messages = this.messages.map((item) => item.role === 'assistant'
      ? { ...item, usage: { ...item.usage, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : item);
    this.messages.push(message);
    this.discardUsage = false;
    this.publish();
  }

  private publish(): void {
    if (!this.model) return;
    const estimate = this.contextWindow ? piContextUsage(this.messages, this.discardUsage) : undefined;
    this.emit({ model: this.model, request: this.request, usedTokens: estimate?.tokens ?? null,
      contextWindow: this.contextWindow, source: estimate?.source ?? 'unknown', updatedAt: Date.now() });
  }
}
