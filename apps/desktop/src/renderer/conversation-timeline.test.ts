import { expect, it } from 'vitest';
import type { ClarificationRequest, ConversationMessage } from '@cloudhelm/contracts';
import { conversationTimeline } from './conversation-timeline.js';

const card: ClarificationRequest = { id: 'q', taskId: 'task', toolCallId: 'call', generation: 'generation',
  createdAt: 1, expiresAt: 100, status: 'answered', questions: [{ id: 'scope', prompt: 'Which environment?' }],
  answers: [{ id: 'scope', value: 'test' }] };
const answer: ConversationMessage = { taskId: 'task', role: 'user', entryId: 'answer', source: 'clarification',
  clarificationToolCallId: 'call', text: '[需求澄清回答] test', createdAt: 2 };

it('deduplicates only a provenance-bound answer that has a rendered answered card', () => {
  const genuine: ConversationMessage = { ...answer, entryId: 'input', source: 'input', clarificationToolCallId: undefined };
  const legacy: ConversationMessage = { ...answer, entryId: 'legacy', source: undefined, clarificationToolCallId: undefined };
  const timeline = conversationTimeline([answer, genuine, legacy], [], [card]);
  expect(timeline.filter((item) => item.kind === 'message').map((item) => item.value.entryId)).toEqual(['input', 'legacy']);
  expect(timeline.filter((item) => item.kind === 'clarification')).toHaveLength(1);
});

it.each(['pending', 'expired', 'cancelled'] as const)('does not hide an answer behind a %s card or a missing/foreign card', (status) => {
  for (const cards of [[], [{ ...card, status, answers: undefined }], [{ ...card, taskId: 'foreign' }], [{ ...card, toolCallId: 'other' }]]) {
    expect(conversationTimeline([answer], [], cards).some((item) => item.kind === 'message')).toBe(true);
  }
});
