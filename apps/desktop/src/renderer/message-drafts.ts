import { create } from 'zustand';
import type { ContextUsageView, MessagePart, ReferenceInfo } from '@cloudhelm/contracts';
export interface MessageDraft { epoch: number; parts: MessagePart[]; caret: number; revision: number; locked: boolean; discarding?: boolean; request?: { id: string; revision: string }; compressing?: boolean; compressingReference?: string; summaryRequests?: { used: number; limit: 32 }; preparationContext?: ContextUsageView }
const empty = (): MessageDraft => ({ epoch: 0, parts: [], caret: 0, revision: 0, locked: false });
export function partLength(part: MessagePart): number { return part.type === 'text' ? part.text.length : 1; }
export function normalizeParts(parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (part.type === 'text' && !part.text) continue;
    if (part.type === 'text' && previous?.type === 'text') previous.text += part.text;
    else result.push({ ...part });
  }
  return result;
}
export function replaceParts(parts: MessagePart[], start: number, end: number, inserted: MessagePart[]): MessagePart[] {
  let offset = 0;
  const before: MessagePart[] = [], after: MessagePart[] = [];
  for (const part of parts) {
    const next = offset + partLength(part);
    if (next <= start) before.push(part);
    else if (offset >= end) after.push(part);
    else if (part.type === 'text') {
      if (start > offset) before.push({ type: 'text', text: part.text.slice(0, start - offset) });
      if (end < next) after.push({ type: 'text', text: part.text.slice(end - offset) });
    }
    offset = next;
  }
  return normalizeParts([...before, ...inserted, ...after]);
}
export function longPaste(text: string): boolean { return text.replace(/\r\n?/gu, '\n').split('\n').length > 10 || [...text].length > 1000; }
export const useMessageDrafts = create<{ drafts: Record<string, MessageDraft>; set(key: string, value: Partial<MessageDraft>): void; clear(key: string): void }>((set) => ({
  drafts: {},
  set: (key, value) => set((state) => {
    const previous = state.drafts[key] ?? empty();
    const newRequest = value.request && value.request.id !== previous.request?.id;
    return { drafts: { ...state.drafts, [key]: { ...previous, ...(newRequest ? { summaryRequests: undefined, preparationContext: undefined } : {}), ...value } } };
  }),
  clear: (key) => set((state) => ({ drafts: { ...state.drafts, [key]: { ...empty(), epoch: (state.drafts[key]?.epoch ?? 0) + 1 } } }))
}));
export function draftFor(key: string): MessageDraft { return useMessageDrafts.getState().drafts[key] ?? empty(); }
/** A completed older send must not unlock a newer draft or retry. */
export function finishDraftRequest(key: string, epoch: number, requestId: string): void {
  const draft = draftFor(key);
  if (draft.epoch !== epoch || draft.request?.id !== requestId) return;
  useMessageDrafts.getState().set(key, { locked: false, compressing: false, compressingReference: undefined, preparationContext: undefined });
}
export function insertTerminalReference(key: string, reference: ReferenceInfo, epoch = draftFor(key).epoch): void {
  const draft = draftFor(key);
  if (draft.epoch !== epoch) throw new Error('草稿已变化，未插入迟到引用');
  if (draft.locked) throw new Error('这条消息正在发送，请等待完成后再添加引用');
  useMessageDrafts.getState().set(key, { parts: replaceParts(draft.parts, draft.caret, draft.caret, [{ type: 'reference', reference }]),
    caret: draft.caret + 1, revision: draft.revision + 1 });
}
