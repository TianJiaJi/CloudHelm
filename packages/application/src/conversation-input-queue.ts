import type { ConversationInput, NewConversationInput } from '@cloudhelm/core';

const live = (value: ConversationInput) => value.status === 'queued' || value.status === 'delivering';
const identity = (value: NewConversationInput) => JSON.stringify([value.kind, value.text, value.intent, value.document ?? null, value.authorizationKey]);
const validId = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/u.test(value);

/** Pure backend state machine: no timers, model calls, SSH or delivery side effects.
 * The SDK adapter consumes IDs; text equality is never a delivery/cancellation capability. */
export class ConversationInputQueue {
  private readonly entries = new Map<string, ConversationInput>();
  constructor(private readonly taskId: string, private readonly persist: (value: ConversationInput) => void,
    private readonly now: () => number = Date.now, private readonly lifetimeMs = 30 * 60_000,
    private readonly capacity = 64) {
    if (!validId(taskId) || !Number.isInteger(capacity) || capacity < 1 || capacity > 256
      || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 24 * 60 * 60_000) throw new Error('Invalid input queue limits');
  }
  enqueue(input: NewConversationInput): ConversationInput {
    this.validate(input); this.expire();
    const previous = this.entries.get(input.id);
    if (previous) {
      if (identity(previous) !== identity(input)) throw new Error('Input ID already bound to another request');
      return structuredClone(previous); // Never requeue a cancelled, expired, failed or delivered ID.
    }
    if ([...this.entries.values()].filter(live).length >= this.capacity) throw new Error('Conversation input queue is full');
    // Receipts are bounded too. Refuse rather than forget IDs and accidentally accept a replay.
    if (this.entries.size >= 1024) throw new Error('Conversation input receipt capacity exhausted');
    const at = this.now();
    return this.commit({ version: 1, id: input.id, taskId: this.taskId, kind: input.kind, text: input.text,
      intent: input.intent, document: input.document && structuredClone(input.document), authorizationKey: input.authorizationKey,
      status: 'queued', createdAt: at, expiresAt: at + this.lifetimeMs, updatedAt: at });
  }
  /** Called only for the exact ID actually selected by the native SDK, before request authorization. */
  beginDelivery(id: string, authorizationKey: string): ConversationInput {
    this.expire(); const entry = this.require(id);
    if (entry.status !== 'queued') throw new Error('Input is no longer pending; do not deliver');
    if (entry.authorizationKey !== authorizationKey) {
      this.commit({ ...entry, status: 'failed', reason: 'authorization-changed', updatedAt: this.now() });
      throw new Error('Queued input authorization changed; prepare it again');
    }
    return this.commit({ ...entry, status: 'delivering', updatedAt: this.now() });
  }
  delivered(id: string, entryId: string): ConversationInput { return this.commit(this.deliveryReceipt(id, entryId)); }
  /** Validate a final receipt without changing state before an async durable acknowledgment. */
  deliveryReceipt(id: string, entryId: string): ConversationInput {
    const entry = this.require(id);
    if (entry.status === 'delivered' && entry.entryId === entryId) return structuredClone(entry);
    if (entry.status !== 'delivering' || !validId(entryId)) throw new Error('Invalid native input delivery receipt');
    return structuredClone({ ...entry, status: 'delivered' as const, entryId, updatedAt: this.now() });
  }
  cancel(id: string): { value: ConversationInput; cancelled: boolean } {
    this.expire(); const entry = this.require(id);
    if (entry.status !== 'queued') return { value: structuredClone(entry), cancelled: entry.status === 'cancelled' };
    return { value: this.commit({ ...entry, status: 'cancelled', reason: 'cancelled', updatedAt: this.now() }), cancelled: true };
  }
  failed(id: string): ConversationInput {
    const entry = this.require(id);
    return live(entry) ? this.commit({ ...entry, status: 'failed', reason: 'delivery-failed', updatedAt: this.now() }) : structuredClone(entry);
  }
  expire(): void {
    const at = this.now();
    for (const entry of this.entries.values()) if (entry.status === 'queued' && entry.expiresAt <= at)
      this.commit({ ...entry, status: 'expired', reason: 'expired', updatedAt: at });
  }
  /** Pending work is never revived by reopening a conversation. */
  restore(values: readonly ConversationInput[]): void {
    if (this.entries.size || values.length > 1024) throw new Error('Invalid input queue recovery');
    const prepared = new Map<string, ConversationInput>();
    for (const value of values) {
      this.validate(value);
      if (value.version !== 1 || value.taskId !== this.taskId || prepared.has(value.id)
        || !['queued', 'delivering', 'delivered', 'cancelled', 'expired', 'failed'].includes(value.status)
        || ![value.createdAt, value.updatedAt, value.expiresAt].every(Number.isFinite)
        || value.expiresAt <= value.createdAt || value.status === 'delivered' && !validId(value.entryId ?? ''))
        throw new Error('Invalid input queue history');
      const restored: ConversationInput = { version: 1, id: value.id, taskId: this.taskId, kind: value.kind,
        text: value.text, intent: value.intent, document: value.document && structuredClone(value.document), authorizationKey: value.authorizationKey,
        status: live(value) ? 'expired' : value.status, reason: live(value) ? 'recovered' : value.reason,
        createdAt: value.createdAt, expiresAt: value.expiresAt, updatedAt: live(value) ? this.now() : value.updatedAt, entryId: value.entryId };
      prepared.set(value.id, restored);
    }
    for (const value of prepared.values()) this.commit(value);
  }
  get(id: string): ConversationInput | undefined { const entry = this.entries.get(id); return entry && structuredClone(entry); }
  snapshot(): ConversationInput[] { return [...this.entries.values()].map((entry) => structuredClone(entry)); }
  private require(id: string): ConversationInput { const entry = this.entries.get(id); if (!entry) throw new Error('Unknown conversation input'); return entry; }
  private commit(value: ConversationInput): ConversationInput {
    this.persist(structuredClone(value)); this.entries.set(value.id, structuredClone(value)); return structuredClone(value);
  }
  private validate(input: NewConversationInput): void {
    if (!validId(input.id) || !['steer', 'followUp'].includes(input.kind)
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 262144
      || typeof input.intent !== 'string' || !input.intent.trim() || input.intent.length > 100000
      || typeof input.authorizationKey !== 'string' || !input.authorizationKey || input.authorizationKey.length > 512
      || input.document && JSON.stringify(input.document).length > 262144) throw new Error('Invalid queued input');
  }
}
