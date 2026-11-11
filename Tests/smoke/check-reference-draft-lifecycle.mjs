/* global window, document */
import assert from 'node:assert/strict';

/** Real Electron IPC/renderer epochs, with synthetic body rows instead of a remote terminal. */
export async function checkReferenceDraftLifecycle({ application, page, owner }, inspect, preloadPath) {
  const first = await page.evaluate(() => window.cloudhelm.openReferenceDraft({ hostId: null }));
  inspect((database) => database.transaction(() => {
    for (const id of ['draft-managed', 'draft-legacy', 'draft-published']) {
      const reference = { id, kind: 'paste', capturedAt: 1 };
      database.prepare('INSERT INTO content_references(id,value) VALUES(?,?)').run(id, JSON.stringify({ reference, original: `synthetic ${id}` }));
      if (id === 'draft-managed') {
        database.prepare('INSERT INTO reference_collection_candidates(reference_id) VALUES(?)').run(id);
        database.prepare('INSERT INTO reference_draft_holds(draft_id,reference_id) VALUES(?,?)').run(first, id);
      }
      if (id === 'draft-published') database.prepare('INSERT INTO records(bucket,id,value,updated_at) VALUES(?,?,?,1)').run('messages', 'draft-published-message', JSON.stringify({
        taskId: 'kept-task', role: 'user', text: 'Synthetic shared source', createdAt: 1,
        document: { requestId: 'draft-published-request', parts: [{ type: 'reference', reference }] }
      }));
    }
  }).immediate());
  const ids = ['draft-managed', 'draft-legacy', 'draft-published'];
  await page.evaluate(({ first, ids }) => window.cloudhelm.claimDraftReferences(first, ids), { first, ids });
  const secondReady = application.waitForEvent('window', { timeout: 20_000 });
  await application.evaluate(async ({ BrowserWindow }, preload) => {
    const primary = BrowserWindow.getAllWindows()[0];
    const second = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true,
      fullscreenable: false, maximizable: false, minimizable: false, webPreferences: { preload,
      contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await second.loadURL(primary.webContents.getURL());
  }, preloadPath);
  const second = await secondReady; await owner.capture();
  try { await second.getByRole('textbox', { name: '给 AI 的消息' }).waitFor(); }
  catch {
    const facts = await second.evaluate(() => ({ api: typeof window.cloudhelm?.openReferenceDraft === 'function',
      ready: document.readyState, rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      editors: document.querySelectorAll('[data-message-editor]').length, width: window.innerWidth, height: window.innerHeight,
      visibility: document.visibilityState }));
    throw new Error(`Secondary renderer readiness failed: ${JSON.stringify(facts)}`);
  }
  const secondLease = await second.evaluate(() => window.cloudhelm.openReferenceDraft({ hostId: null }));
  assert.equal(await second.evaluate(async (first) => {
    try { await window.cloudhelm.claimDraftReferences(first, ['draft-managed']); return false; } catch { return true; }
  }, first), true, 'a second renderer cannot claim into the first renderer lease');
  await second.evaluate(({ id, ids }) => window.cloudhelm.claimDraftReferences(id, ids), { id: secondLease, ids });
  await page.reload(); await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor(); await owner.capture();
  assert.equal(await page.evaluate(async (first) => {
    try { await window.cloudhelm.claimDraftReferences(first, ['draft-managed']); return false; } catch { return true; }
  }, first), true, 'same-webContents reload must revoke the old recipient');
  assert.equal(await page.evaluate(async () => !!await window.cloudhelm.readReference('draft-managed')), true, 'other-window hold survives reload');
  await second.close();
  await page.waitForFunction(async () => { try { await window.cloudhelm.readReference('draft-managed'); return false; } catch { return true; } });
  assert.deepEqual(await page.evaluate(async () => ({
    legacy: !!await window.cloudhelm.readReference('draft-legacy'), published: !!await window.cloudhelm.readReference('draft-published')
  })), { legacy: true, published: true });
  const finalLease = await page.evaluate(async () => {
    const id = await window.cloudhelm.openReferenceDraft({ hostId: null });
    await window.cloudhelm.claimDraftReferences(id, ['draft-published']); return id;
  });
  await page.evaluate(() => window.cloudhelm.deleteConversation('kept-task'));
  assert.equal(await page.evaluate(async () => !!await window.cloudhelm.readReference('draft-published')), true, 'draft protects a released durable message owner');
  await page.evaluate((id) => window.cloudhelm.releaseReferenceDraft(id), finalLease);
  assert.equal(await page.evaluate(async () => {
    try { await window.cloudhelm.readReference('draft-published'); return false; } catch { return true; }
  }), true, 'last hold collects the released message body');
  return { rendererIsolation: true, reloadRevokesOldLease: true, sharedHoldPreserved: true, legacyOriginalPreserved: true, delayedCollection: true };
}
