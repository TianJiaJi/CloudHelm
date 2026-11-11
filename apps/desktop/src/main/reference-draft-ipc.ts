import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { ReferenceDraftScope, TerminalQuoteRequest } from '@cloudhelm/contracts';
import type { ReferenceStore } from './reference-store.js';

export function registerReferenceDraftIpc(store: SqliteStore, references: ReferenceStore,
  revoke: (recipient: string, draftId?: string) => void, assertConversationAvailable?: (id: string) => void) {
  const recipients = new WeakMap<WebContents, string>(), watched = new WeakSet<WebContents>(), navigating = new WeakSet<WebContents>(), pendingCleanup = new Set<string>();
  function retire(sender: WebContents): void {
    const id = recipients.get(sender);
    if (!id) return;
    recipients.delete(sender); revoke(id); pendingCleanup.add(id);
    try { store.releaseReferenceRecipient(id); pendingCleanup.delete(id); } catch { /* Durable lease remains for retry/startup. */ }
  }
  function recipient(event: IpcMainInvokeEvent): string {
    const sender = event.sender, frame = event.senderFrame;
    if (!sender || sender.isDestroyed() || navigating.has(sender) || sender.isLoadingMainFrame() || !frame || frame.isDestroyed()
      || frame.processId !== sender.mainFrame.processId || frame.routingId !== sender.mainFrame.routingId) throw new Error('界面已关闭或正在重新加载，请稍后重试');
    for (const id of pendingCleanup) { store.releaseReferenceRecipient(id); pendingCleanup.delete(id); }
    let id = recipients.get(sender);
    if (!id) { id = randomUUID(); recipients.set(sender, id); }
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.on('did-start-navigation', (event) => {
        if (event.isMainFrame && !event.isSameDocument) { navigating.add(sender); retire(sender); }
      });
      sender.on('did-stop-loading', () => navigating.delete(sender));
      sender.on('render-process-gone', () => retire(sender));
      sender.once('destroyed', () => retire(sender));
    }
    return id;
  }
  function available(scope: ReferenceDraftScope): void {
    if (!scope || (scope.hostId !== null && typeof scope.hostId !== 'string')) throw new Error('无效引用草稿目标');
    if (scope.conversationId !== undefined) assertConversationAvailable?.(scope.conversationId);
  }
  ipcMain.handle('cloudhelm:open-reference-draft', (event, scope: ReferenceDraftScope) => {
    const owner = recipient(event); available(scope);
    const id = randomUUID(); store.createReferenceDraft(id, owner, scope); return id;
  });
  ipcMain.handle('cloudhelm:claim-draft-references', (event, id: string, ids: string[]) => {
    const owner = recipient(event); available(store.assertReferenceDraft(id, owner));
    store.claimDraftReferences(id, owner, ids);
  });
  ipcMain.handle('cloudhelm:release-reference-draft', (event, id: string) => {
    const owner = recipient(event);
    revoke(owner, id); store.releaseReferenceDraft(id, owner);
  });
  ipcMain.handle('cloudhelm:quote-terminal', (event, input: TerminalQuoteRequest) => {
    const owner = recipient(event);
    available(store.assertReferenceDraft(input?.draftId, owner));
    return references.quote(input, owner);
  });
  return { recipient };
}
