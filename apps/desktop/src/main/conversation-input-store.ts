import type { SqliteStore } from '@cloudhelm/adapters';
import { ConversationInputQueue } from '@cloudhelm/application';
import { conversationInputView, type ConversationInputView, type StoredConversationInput } from '@cloudhelm/contracts';

const identity = (value: StoredConversationInput) => JSON.stringify([value.taskId, value.kind, value.text, value.intent,
  value.document ?? null, value.authorizationKey, value.createdAt, value.expiresAt]);
const transitions: Record<StoredConversationInput['status'], readonly StoredConversationInput['status'][]> = {
  queued: ['queued', 'delivering', 'cancelled', 'expired', 'failed'], delivering: ['delivering', 'delivered', 'expired', 'failed'],
  delivered: ['delivered'], cancelled: ['cancelled'], expired: ['expired'], failed: ['failed']
};

/** Durable receipts; this store never delivers a message or starts a model. */
export class ConversationInputStore {
  private readonly values = new Map<string, StoredConversationInput>();
  constructor(private readonly store: SqliteStore, private readonly hasTask: (id: string) => boolean) {
    const groups = new Map<string, StoredConversationInput[]>();
    for (const value of store.list<StoredConversationInput>('conversation-inputs')) {
      if (!hasTask(value.taskId)) continue;
      groups.set(value.taskId, [...(groups.get(value.taskId) ?? []), value]);
    }
    for (const [taskId, values] of groups) {
      const ledger = new ConversationInputQueue(taskId, (value) => {
        this.store.put('conversation-inputs', value.id, value); this.values.set(value.id, value);
      });
      ledger.restore(values); // Expire pending delivery before any Worker is restored.
    }
  }
  commit(value: StoredConversationInput): void {
    if (!this.hasTask(value.taskId)) throw new Error('Conversation input owner unavailable');
    // Reuse the backend schema/recipient checks without adopting its recovery transition.
    const validation = new ConversationInputQueue(value.taskId, () => {});
    validation.restore([value]);
    const previous = this.values.get(value.id);
    if (previous && (identity(previous) !== identity(value) || !transitions[previous.status].includes(value.status)
      || previous.status === 'delivered' && previous.entryId !== value.entryId || value.updatedAt < previous.updatedAt))
      throw new Error('Conversation input receipt changed or regressed');
    if (!previous && value.status !== 'queued' && value.status !== 'expired') throw new Error('Conversation input was not admitted');
    const copy = structuredClone(value);
    this.store.put('conversation-inputs', copy.id, copy); this.values.set(copy.id, copy);
  }
  list(taskId: string): StoredConversationInput[] {
    return [...this.values.values()].filter((value) => value.taskId === taskId).map((value) => structuredClone(value));
  }
  snapshot(): ConversationInputView[] { return [...this.values.values()].map(conversationInputView); }
  invalidate(): void {
    for (const value of this.values.values()) if (value.status === 'queued' || value.status === 'delivering')
      this.commit({ ...value, status: 'expired', reason: 'recovered', updatedAt: Date.now() });
  }
  removeTask(taskId: string): void {
    this.store.removeWhere('conversation-inputs', 'taskId', taskId);
    this.forgetTask(taskId);
  }
  /** Called only after the owning conversation's deletion transaction commits. */
  forgetTask(taskId: string): void {
    for (const [id, value] of this.values) if (value.taskId === taskId) this.values.delete(id);
  }
}
