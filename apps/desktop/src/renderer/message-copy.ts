import type { MessagePart } from '@cloudhelm/contracts';
export async function expandedMessageText(parts: MessagePart[], actualSent = false): Promise<string> {
  return (await Promise.all(parts.map(async (part) => {
    if (part.type === 'text') return part.text;
    if (part.content !== undefined) return part.content;
    const body = await window.cloudhelm.readReference(part.reference.id);
    return actualSent ? body.summary ?? body.original : body.original;
  }))).join('');
}
