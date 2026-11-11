import { randomUUID } from 'node:crypto';
import { redactOutput } from '@cloudhelm/core';
import type { MessagePart, ReferenceBody } from '@cloudhelm/contracts';
import type { ReferenceStore } from './reference-store.js';

/** Resolve canonical originals and holds before credentials, SSH restoration or model preparation. */
export function materializeMessage(parts: MessagePart[], hostId: string | null | undefined, references: ReferenceStore,
  assertHeld: (id: string) => void): { parts: MessagePart[]; bodies: ReferenceBody[] } {
  const bodies: ReferenceBody[] = [];
  const projected: MessagePart[] = parts.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: redactOutput(part.text) };
    if (part.type !== 'reference' || !part.reference) throw new Error('无效消息片段');
    let body: ReferenceBody;
    if (part.reference.kind === 'paste' && typeof part.content === 'string') {
      body = { reference: { id: randomUUID(), kind: 'paste', capturedAt: Date.now() }, original: redactOutput(part.content) };
    } else {
      body = references.read(part.reference.id);
      if (body.reference.kind === 'terminal' && body.reference.hostId !== hostId) throw new Error('终端引用与目标主机不一致');
      assertHeld(body.reference.id);
    }
    body = { reference: { ...body.reference, id: randomUUID(), summarized: false }, original: body.original };
    bodies.push(body);
    return { type: 'reference', instanceId: part.instanceId ?? part.reference.id, reference: body.reference };
  });
  if (!projected.some((part) => part.type === 'reference' || part.text.trim())) throw new Error('请输入消息');
  return { parts: projected, bodies };
}
