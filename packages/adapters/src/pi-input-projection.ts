import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { queuedInputType } from './pi-input-queue.js';

type Allowed = ((id: string) => boolean) | undefined;
export function inputVisible(message: AgentMessage, allowed: Allowed): boolean {
  return message.role !== 'custom' || message.customType !== queuedInputType || accepts(message.details, allowed);
}
function accepts(details: unknown, allowed: Allowed): boolean {
  if (!allowed) return true;
  const id = details && typeof details === 'object' && 'id' in details ? details.id : undefined;
  try { return typeof id === 'string' && allowed(id) === true; } catch { return false; }
}
function deniedInputs(branch: SessionEntry[], allowed: Allowed): Set<string> {
  const denied = new Set(branch.filter((entry) => entry.type === 'custom_message'
    && entry.customType === queuedInputType && !accepts(entry.details, allowed)).map((entry) => entry.id));
  if (!denied.size) return denied;
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const omitted = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (entry.type === 'context_edit' && denied.has(entry.targetId)) {
      if (entry.replacement === null) omitted.add(entry.targetId); else omitted.delete(entry.targetId);
    }
    if (entry.type !== 'compaction') continue;
    // A previous summary may already contain an unapproved input. Never pretend that
    // omitting its raw entry repairs a model-generated summary or sanitizes the archive.
    const kept = positions.get(entry.firstKeptEntryId) ?? index;
    if ([...denied].some((id) => positions.get(id)! < Math.min(index, kept) && !omitted.has(id))) {
      throw new Error('旧摘要可能包含未获准投递的队列内容，已停止；请新建会话，原始历史仍保留。');
    }
  }
  return denied;
}
/** Offline measurement: no persistence, model request, or probe. */
export function inputProjection(manager: Pick<SessionManager, 'getBranch' | 'buildSessionProjection'>, allowed: Allowed): AgentMessage[] {
  deniedInputs(manager.getBranch(), allowed);
  return manager.buildSessionProjection().messages.filter((message) => inputVisible(message, allowed));
}
/** Apply only at an explicitly authorized turn/compaction boundary. The raw entries stay intact. */
export function omitUnapprovedInputs(manager: SessionManager, allowed: Allowed): void {
  const branch = manager.getBranch(), denied = deniedInputs(branch, allowed);
  const edits = new Map(branch.filter((entry) => entry.type === 'context_edit').map((entry) => [entry.targetId, entry.replacement]));
  for (const id of denied) if (!edits.has(id) || edits.get(id) !== null) manager.appendContextEdit(id, null);
}
