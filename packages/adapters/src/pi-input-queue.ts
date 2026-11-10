import { randomUUID } from 'node:crypto';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { ConversationInput } from '@cloudhelm/core';

export const queuedInputType = 'cloudhelm-queued-input';
export type NativeQueuedInput = Pick<ConversationInput, 'id' | 'kind' | 'text' | 'document'>;
export type NativeInputMessage = AgentMessage;
export type QueueAgent = Pick<Agent, 'steer' | 'followUp' | 'peekQueuedMessages' | 'clearAllQueues' | 'steeringMode' | 'followUpMode'>;

/** Transport replica, NOT an authorization ledger. Only one native slot is armed at once,
 * so public peek/clear APIs can distinguish cancellation from already-selected delivery.
 * Backend IDs are private custom-message metadata, never parsed from user text. */
export class PiInputQueue {
  private readonly scope = randomUUID();
  private readonly pending = new Map<string, NativeQueuedInput>();
  private readonly retired = new Set<string>();
  private armed?: string;
  constructor(private readonly agent: QueueAgent, private readonly onSelected: (input: NativeQueuedInput) => void | Promise<void>) {
    agent.steeringMode = 'one-at-a-time'; agent.followUpMode = 'one-at-a-time';
  }
  enqueue(input: NativeQueuedInput): void {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/u.test(input.id) || this.pending.has(input.id) || this.retired.has(input.id)
      || !['steer', 'followUp'].includes(input.kind) || this.pending.size >= 64 || this.retired.size >= 1024) throw new Error('Invalid or repeated native queued input');
    this.pending.set(input.id, structuredClone(input));
    // A newly accepted correction may replace an unconsumed native followUp slot.
    // The followUp remains in the backend-correlated waiting set, not a second native copy.
    if (input.kind === 'steer' && this.armed && this.pending.get(this.armed)?.kind === 'followUp' && this.isArmedPending()) {
      this.agent.clearAllQueues(); this.armed = undefined;
    }
    this.arm();
  }
  cancel(id: string): boolean {
    if (!this.pending.has(id)) return false;
    if (this.armed === id) {
      if (!this.isArmedPending()) return false; // Already selected by the loop; never promise a false cancellation.
      this.agent.clearAllQueues(); this.armed = undefined;
    }
    this.pending.delete(id); this.retired.add(id); this.arm(); return true;
  }
  /** Called from the awaited native message_start subscription, before any next request. */
  async observe(message: AgentMessage): Promise<void> {
    const id = this.idOf(message);
    if (!id) return;
    const input = this.pending.get(id);
    if (!input || id !== this.armed || this.retired.has(id)) throw new Error('Native queued input recipient changed');
    this.armed = undefined; this.pending.delete(id); this.retired.add(id);
    await this.onSelected(structuredClone(input));
    this.arm();
  }
  clear(): string[] {
    // An already selected slot is no longer cancellable; leave its ID for its imminent receipt.
    const selected = this.armed && !this.isArmedPending() ? this.armed : undefined;
    this.agent.clearAllQueues();
    const cancelled = [...this.pending.keys()].filter((id) => id !== selected);
    for (const id of cancelled) { this.pending.delete(id); this.retired.add(id); }
    this.armed = selected || undefined;
    return cancelled;
  }
  private isArmedPending(): boolean { return this.agent.peekQueuedMessages().some((message) => this.idOf(message) === this.armed); }
  idOf(message: AgentMessage): string | undefined {
    if (message.role !== 'custom' || message.customType !== queuedInputType) return undefined;
    const details = message.details as { id?: unknown; scope?: unknown } | undefined;
    return details?.scope === this.scope && typeof details.id === 'string' ? details.id : undefined;
  }
  private arm(): void {
    if (this.armed) return;
    const values = [...this.pending.values()], next = values.find((input) => input.kind === 'steer') ?? values[0];
    if (!next) return;
    const message = { role: 'custom' as const, customType: queuedInputType, content: next.text, display: true,
      details: { version: 1, scope: this.scope, id: next.id, kind: next.kind, document: next.document }, timestamp: Date.now() };
    this.armed = next.id;
    if (next.kind === 'steer') this.agent.steer(message); else this.agent.followUp(message);
  }
}
