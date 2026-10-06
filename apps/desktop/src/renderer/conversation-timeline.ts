import type { ConversationMessage, OperationView } from '@cloudhelm/contracts';

type TimelineEntry =
  | { kind: 'message'; key: string; value: ConversationMessage }
  | { kind: 'operation'; key: string; value: OperationView };

/** Project backend timestamps into one timeline, keeping results before their explanation. */
export function conversationTimeline(messages: ConversationMessage[], operations: OperationView[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((value, index): TimelineEntry => ({ kind: 'message', key: `message:${value.createdAt}:${index}`, value })),
    ...operations.map((value): TimelineEntry => ({ kind: 'operation', key: `operation:${value.id}`, value }))
  ];
  // Millisecond timestamps can tie: user input precedes execution, and AI explanations follow it.
  const priority = (entry: TimelineEntry): number => entry.kind === 'operation' ? 1 : entry.value.role === 'user' ? 0 : 2;
  return entries.sort((a, b) => a.value.createdAt - b.value.createdAt || priority(a) - priority(b));
}
