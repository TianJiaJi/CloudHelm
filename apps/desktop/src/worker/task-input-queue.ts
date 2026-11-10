import { createHash } from 'node:crypto';
import type { TaskView } from '@cloudhelm/contracts';
import type { RuntimeHost, RuntimeProfile } from '@cloudhelm/contracts/runtime';
import type { HostEnvironmentAccess } from '@cloudhelm/core';
import { ConversationInputQueue } from '@cloudhelm/application';
import type { ConversationInput, ConversationSession, NewConversationInput, QueuedSessionInput } from '@cloudhelm/core';

interface Dependencies {
  session(): ConversationSession;
  authorizationKey(): string;
  assertActive(): void;
  publish(value: ConversationInput): void;
  commit(value: ConversationInput): Promise<void>;
  activate(value: ConversationInput): void;
  failed(): void;
}

/** Binds durable backend receipts to native SDK consumption, not to renderer guesses. */
export class TaskInputQueue {
  private readonly ledger: ConversationInputQueue;
  private readonly submitted = new Set<string>();
  private readonly persistedExpirations = new Set<string>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(taskId: string, prior: readonly ConversationInput[], private readonly deps: Dependencies) {
    this.ledger = new ConversationInputQueue(taskId, (value) => deps.publish(value));
    this.ledger.restore(prior); // Main has already expired these before Worker restoration; never re-enqueue.
    for (const value of this.ledger.snapshot()) if (value.status === 'expired') this.persistedExpirations.add(value.id);
  }
  async enqueue(input: Omit<NewConversationInput, 'authorizationKey'>): Promise<ConversationInput> {
    this.assertActive(); await this.expire(); this.assertActive();
    const value = this.ledger.enqueue({ ...input, authorizationKey: this.deps.authorizationKey() });
    if (value.status !== 'queued' || this.submitted.has(value.id)) return value;
    this.scheduleExpiry();
    try {
      await this.expire(); // Includes expirations produced by the pure ledger operation itself.
      await this.deps.commit(value);
      this.assertActive();
      const current = this.ledger.get(value.id)!;
      if (current.status !== 'queued' || this.submitted.has(current.id)) return current; // Cancellation or a concurrent same-ID acknowledgment won.
      if (current.authorizationKey !== this.deps.authorizationKey()) throw new Error('Queued input scope changed');
      const session = this.deps.session();
      if (!session.queueInput || !session.cancelQueuedInput || !session.isStreaming) throw new Error('Active native input queue unavailable; send a new explicit message');
      this.submitted.add(current.id);
      session.queueInput({ id: current.id, kind: current.kind, text: current.text, document: current.document });
      return this.ledger.get(current.id)!;
    } catch {
      this.deps.failed();
      const failed = this.ledger.failed(value.id);
      await this.deps.commit(failed);
      throw new Error('消息未投递；请核验队列状态后重新发送。');
    }
  }
  async selected(input: QueuedSessionInput): Promise<void> {
    try {
      this.assertActive();
      const value = this.ledger.get(input.id);
      if (!value || !this.submitted.has(input.id) || value.text !== input.text || value.kind !== input.kind)
        throw new Error('Native input receipt does not belong to this conversation');
      const selected = this.ledger.beginDelivery(input.id, this.deps.authorizationKey()); this.scheduleExpiry();
      await this.expire(); await this.deps.commit(selected);
      this.assertActive();
      const current = this.ledger.get(input.id)!;
      if (current.status !== 'delivering' || current.authorizationKey !== this.deps.authorizationKey())
        throw new Error('Input authorization or delivery state changed during acknowledgment');
      this.deps.activate(current); // The only point where queued input may change the active intent.
    } catch {
      this.deps.failed();
      try { await this.expire(); } catch { /* Expiration is already enforced locally. */ }
      if (this.ledger.get(input.id)) try { await this.deps.commit(this.ledger.failed(input.id)); } catch { /* Already paused; never retry delivery. */ }
      throw new Error('消息投递未获得后端确认，本轮已暂停。');
    }
  }
  async delivered(id: string, entryId: string): Promise<void> {
    this.assertActive();
    const value = this.ledger.deliveryReceipt(id, entryId);
    try { await this.deps.commit(value); this.assertActive(); this.ledger.delivered(id, entryId); }
    catch {
      this.deps.failed();
      try { await this.deps.commit(this.ledger.failed(id)); } catch { /* Failed receipt stays ineligible for model history. */ }
      throw new Error('消息历史回执未获得确认，本轮已暂停。');
    }
    this.submitted.delete(id);
  }
  async cancel(id: string): Promise<{ value: ConversationInput; cancelled: boolean }> {
    const value = this.ledger.get(id);
    if (!value) throw new Error('Unknown conversation input');
    if (value.status === 'queued' && this.submitted.has(id)) {
      if (!this.deps.session().cancelQueuedInput?.(id)) return { value, cancelled: false };
      this.submitted.delete(id);
    }
    const result = this.ledger.cancel(id); this.scheduleExpiry();
    try { await this.expire(); await this.deps.commit(result.value); }
    catch { this.deps.failed(); throw new Error('取消状态未获得持久化确认，本轮已暂停。'); }
    return result;
  }
  async stop(): Promise<void> {
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    const changed: ConversationInput[] = [];
    for (const value of this.ledger.snapshot()) if (value.status === 'queued' || value.status === 'delivering') {
      const cancelled = !this.submitted.has(value.id) || this.deps.session().cancelQueuedInput?.(value.id) === true;
      this.submitted.delete(value.id);
      changed.push(value.status === 'queued' && cancelled ? this.ledger.cancel(value.id).value : this.ledger.failed(value.id));
    }
    await Promise.all(changed.map((value) => this.deps.commit(value)));
  }
  dispose(): void { this.closed = true; void this.stop().catch(() => {}); }
  private assertActive(): void { if (this.closed) throw new Error('Input queue closed'); this.deps.assertActive(); }
  private async expire(): Promise<void> {
    this.ledger.expire();
    const due = this.ledger.snapshot().filter((value) => value.status === 'expired' && !this.persistedExpirations.has(value.id));
    for (const value of due) {
      if (this.submitted.has(value.id)) this.deps.session().cancelQueuedInput?.(value.id);
      this.submitted.delete(value.id); this.persistedExpirations.add(value.id);
    }
    this.scheduleExpiry();
    try { await Promise.all(due.map((value) => this.deps.commit(value))); }
    catch { this.deps.failed(); throw new Error('过期消息状态未获得确认，本轮已暂停。'); }
  }
  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    if (this.closed) return;
    const deadlines = this.ledger.snapshot().filter((value) => value.status === 'queued').map((value) => value.expiresAt);
    if (!deadlines.length) return;
    this.expiryTimer = setTimeout(() => { void this.expire().catch(() => { if (!this.closed) this.deps.failed(); }); },
      Math.max(0, Math.min(...deadlines) - Date.now()));
    this.expiryTimer.unref?.();
  }
  get hasPending(): boolean { return this.ledger.snapshot().some((value) => value.status === 'queued' || value.status === 'delivering'); }
  allowsHistory(id: string): boolean {
    const status = this.ledger.get(id)?.status;
    return status === 'delivering' || status === 'delivered';
  }
  snapshot(): ConversationInput[] { return this.ledger.snapshot(); }
}

export function inputAuthorizationKey(task: TaskView, hosts: RuntimeHost[], profile: RuntimeProfile, environment?: HostEnvironmentAccess): string {
  return createHash('sha256').update(JSON.stringify({ taskId: task.id, hostIds: task.hostIds, scopes: task.localScopes,
    reviewRevision: task.reviewRevision, reviewModes: task.reviewModesByHost,
    hosts: hosts.map((host) => [host.id, host.username, host.policyRevision, environment?.snapshot(host.id, host.username).connectionId]),
    model: [profile.provider, profile.modelId, profile.baseUrl, profile.credentialRevision, profile.contextWindow, profile.maxTokens],
    reviewerRevision: profile.reviewer?.revision })).digest('hex');
}
