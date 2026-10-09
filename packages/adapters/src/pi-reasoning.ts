import { randomUUID } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { redactOutput, type ReasoningProgress, type ReasoningView } from '@cloudhelm/core';

/** Only provider-returned visible text. Opaque signatures/redacted payloads never cross this boundary. */
export function reasoningView(message: AssistantMessage, streaming = false, enabled = false): ReasoningView | undefined {
  const parts = message.content.filter((part) => part.type === 'thinking');
  const text = redactOutput(parts.filter((part) => !part.redacted).map((part) => part.thinking).join('\n\n'));
  const redacted = parts.some((part) => part.redacted);
  if (!parts.length && !enabled && (!message.thinkingLevel || message.thinkingLevel === 'off')) return;
  return { text, redacted: redacted || undefined,
    kind: ['openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(message.api) ? 'summary' : 'thinking',
    status: streaming ? 'streaming' : ['aborted', 'error'].includes(message.stopReason) ? 'interrupted' : text ? 'complete' : 'unavailable' };
}

/** Coalesces stream updates; native Pi owns final transcript persistence. */
export class PiReasoningStream {
  private current?: ReasoningProgress;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly emit: (value: ReasoningProgress | null) => void) {}
  update(message: AssistantMessage, enabled: boolean): void {
    const reasoning = reasoningView(message, true, enabled);
    if (!reasoning) return;
    this.current = { id: this.current?.id ?? randomUUID(), createdAt: message.timestamp,
      model: { provider: message.provider, modelId: message.model }, reasoning };
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.current) this.emit(this.current);
    }, 60);
  }
  clear(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.current) { this.current = undefined; this.emit(null); }
  }
}
