import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ClarificationAnswer, ClarificationQuestion } from '@cloudhelm/core';
import { description, guidelines } from './prompts.js';

export const ASK_CHANNEL = 'cloudhelm:ask-user';
export interface AskBridgeEvent {
  toolCallId: string; questions: ClarificationQuestion[]; signal?: AbortSignal;
  response?: Promise<ClarificationAnswer[]>;
}

/** Standard Pi extension entry. UI transport is provided by the CloudHelm host event bridge. */
export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ask_user', label: '需求澄清', description,
    promptSnippet: description, promptGuidelines: guidelines,
    parameters: Type.Object({ questions: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }), prompt: Type.String({ minLength: 1, maxLength: 1000 }),
      options: Type.Optional(Type.Array(Type.Object({ value: Type.String({ minLength: 1, maxLength: 100 }),
        label: Type.String({ minLength: 1, maxLength: 150 }), description: Type.Optional(Type.String({ maxLength: 500 })),
        recommended: Type.Optional(Type.Boolean()) }), { minItems: 2, maxItems: 5 }))
    }), { minItems: 1, maxItems: 3 }) }),
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Clarification interrupted');
      const event: AskBridgeEvent = { toolCallId, questions: params.questions, signal };
      pi.events.emit(ASK_CHANNEL, event);
      if (!event.response) throw new Error('CloudHelm clarification bridge is unavailable');
      const answers = await event.response;
      const result = { questions: params.questions, answers };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  });
}
