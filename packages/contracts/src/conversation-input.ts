import type { MessageDocument } from './message-content.js';

export type ConversationInputKind = 'steer' | 'followUp';
export type ConversationInputStatus = 'queued' | 'delivering' | 'delivered' | 'cancelled' | 'expired' | 'failed';
export interface ConversationInputView {
  version: 1; id: string; taskId: string; kind: ConversationInputKind; status: ConversationInputStatus;
  preview: string; createdAt: number; updatedAt: number; expiresAt: number; entryId?: string;
  reason?: 'cancelled' | 'expired' | 'recovered' | 'authorization-changed' | 'delivery-failed';
}
/** Main/Worker only. Prepared reference bodies are not included in renderer snapshots. */
export interface StoredConversationInput extends Omit<ConversationInputView, 'preview'> {
  text: string; intent: string; document?: MessageDocument; authorizationKey: string;
}
export function conversationInputView(value: StoredConversationInput): ConversationInputView {
  return { version: 1, id: value.id, taskId: value.taskId, kind: value.kind, status: value.status,
    preview: value.intent.slice(0, 2000), createdAt: value.createdAt, updatedAt: value.updatedAt,
    expiresAt: value.expiresAt, entryId: value.entryId, reason: value.reason };
}
