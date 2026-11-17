import { randomUUID } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TextProgress } from '@cloudhelm/core';

/** Coalesces visible assistant text updates; native Pi owns final transcript persistence. */
export class PiTextStream {
  private current?: TextProgress;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly emit: (value: TextProgress | null) => void) {}
  update(message: AssistantMessage): void {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (!text.trim()) return;
    this.current = { id: this.current?.id ?? randomUUID(), createdAt: message.timestamp,
      model: { provider: message.provider, modelId: message.model }, text };
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.current) this.emit(this.current);
    }, 60);
  }
  clear(): void {
    const unflushed = this.timer !== undefined;
    clearTimeout(this.timer); this.timer = undefined;
    const current = this.current; this.current = undefined;
    if (unflushed && current) this.emit(current);
    if (current) this.emit(null);
  }
}
