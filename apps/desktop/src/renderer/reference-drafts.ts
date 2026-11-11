import type { MessagePart, ReferenceDraftScope } from '@cloudhelm/contracts';
import { draftFor, useMessageDrafts } from './message-drafts.js';

interface Lease { epoch: number; scope: string; promise: Promise<string> }
const leases = new Map<string, Lease>(), pendingRelease = new Set<string>();
async function release(id: string): Promise<void> {
  pendingRelease.add(id);
  await window.cloudhelm.releaseReferenceDraft(id);
  pendingRelease.delete(id);
}
const current = (key: string, lease: Lease) => leases.get(key) === lease && draftFor(key).epoch === lease.epoch;
useMessageDrafts.subscribe(() => {
  for (const [key, lease] of leases) if (!current(key, lease)) {
    leases.delete(key);
    void lease.promise.then(release).catch(() => {}); // Retry failures before the next claim; renderer teardown is the durable fallback.
  }
});

export async function holdDraftReferences(key: string, scope: ReferenceDraftScope, parts: MessagePart[], allowLocked = false): Promise<string> {
  const before = draftFor(key), epoch = before.epoch;
  if (before.discarding || (!allowLocked && before.locked)) throw new Error('这条消息正在发送，请等待完成后再添加引用');
  for (const id of pendingRelease) await release(id);
  if (draftFor(key).epoch !== epoch) throw new Error('草稿已变化，请重新添加引用');
  const binding = JSON.stringify([scope.conversationId ?? null, scope.hostId]);
  let lease = leases.get(key);
  if (lease && lease.scope !== binding) throw new Error('草稿目标已变化，请先丢弃旧草稿');
  if (!lease) {
    const opened: Lease = { epoch, scope: binding, promise: Promise.resolve('') }; leases.set(key, opened);
    opened.promise = Promise.resolve().then(async () => {
      if (!current(key, opened)) throw new Error('草稿已变化，请重新添加引用');
      const id = await window.cloudhelm.openReferenceDraft(scope);
      if (!current(key, opened)) { await release(id); throw new Error('草稿已变化，未保留迟到引用'); }
      return id;
    }).catch((error: unknown) => { if (leases.get(key) === opened) leases.delete(key); throw error; });
    lease = opened;
  }
  const id = await lease.promise;
  const ids = [...new Set(parts.filter((part) => part.type === 'reference' && !(part.reference.kind === 'paste' && typeof part.content === 'string'))
    .map((part) => part.type === 'reference' ? part.reference.id : ''))];
  if (ids.length) await window.cloudhelm.claimDraftReferences(id, ids);
  if (!current(key, lease) || draftFor(key).discarding || (!allowLocked && draftFor(key).locked)) throw new Error('草稿已变化，未插入引用');
  return id;
}

/** Explicit discard waits for persistence; a failed release does not erase the visible draft. */
export async function discardReferenceDraft(key: string): Promise<boolean> {
  const epoch = draftFor(key).epoch, lease = leases.get(key);
  if (draftFor(key).locked) throw new Error('请先取消发送准备，再丢弃草稿');
  useMessageDrafts.getState().set(key, { locked: true, discarding: true });
  try {
    // Failed explicit discard leaves a live visible draft, not a retired cleanup job.
    // Only another explicit discard may retry deleting this lease.
    if (lease) await window.cloudhelm.releaseReferenceDraft(await lease.promise);
    if (draftFor(key).epoch !== epoch) return false;
    useMessageDrafts.getState().clear(key); return true;
  } finally {
    if (draftFor(key).epoch === epoch) useMessageDrafts.getState().set(key, { locked: false, discarding: false });
  }
}

/** Snapshot is authoritative; remove only drafts attached to conversations actually removed. */
export function forgetConversationDrafts(ids: string[]): void {
  for (const key of new Set([...Object.keys(useMessageDrafts.getState().drafts), ...leases.keys()])) if (ids.some((id) => key === id || key.startsWith(`edit:${id}:`)))
    useMessageDrafts.getState().clear(key);
}
