import type { MessageDocument } from './message-content.js';

export type ConversationInputKind = 'steer' | 'followUp';
export type ConversationInputStatus = 'queued' | 'delivering' | 'delivered' | 'cancelled' | 'expired' | 'failed';
/** Backend-owned queue receipt. Content is genuine prepared input, never a credential answer. */
export interface ConversationInput {
  version: 1;
  id: string;
  taskId: string;
  kind: ConversationInputKind;
  status: ConversationInputStatus;
  text: string;
  intent: string;
  document?: MessageDocument;
  /** Captured authorization/account/policy binding; not a history/context-size revision. */
  authorizationKey: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  entryId?: string;
  reason?: 'cancelled' | 'expired' | 'recovered' | 'authorization-changed' | 'delivery-failed';
}
export type NewConversationInput = Pick<ConversationInput, 'id' | 'kind' | 'text' | 'intent' | 'document' | 'authorizationKey'>;
