import { useRef, useState } from 'react';
import type { ConversationMessage } from '@cloudhelm/contracts';
import { Icon } from './ui-helpers.js';
import { copyEntries } from './clipboard.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import styles from './user-message.module.css';
import ui from './ui.module.css';

export function UserMessage({ message, canEdit, report }: {
  message: ConversationMessage; canEdit: boolean; report(error: string): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const sending = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const sentAt = new Date(message.createdAt);
  const timestamp = sentAt.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(message.text); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  }
  function cancel(): void {
    if (sending.current) return;
    setEditing(false); setDraft(message.text);
    editButton.current?.focus({ preventScroll: true });
  }
  /** Editor actions stay available from the right-click menu, not just the icon row. */
  function messageMenu(): ContextMenuEntry[] {
    const entries = copyEntries('复制文本', message.text, report);
    entries.push({ id: 'd1', separator: true },
      { id: 'edit', label: '编辑消息', icon: 'edit', disabled: !canEdit || busy,
        run: () => { setDraft(message.text); setEditing(true); } });
    return entries;
  }
  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || text === message.text.trim() || !canEdit || sending.current) return;
    sending.current = true; setBusy(true);
    try {
      await window.cloudhelm.sendMessage(message.taskId, text, []);
      setEditing(false); report('');
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { sending.current = false; setBusy(false); }
  }

  return <article className={`${ui.message} ${ui.userMessage} ${styles.message}`} aria-label="用户消息"
    onContextMenu={(event) => openContextMenu(event, messageMenu(), '消息操作')}>
    <div className={styles.header}><strong>你</strong>
      <div className={styles.actions}>
        <time dateTime={sentAt.toISOString()} title={`发送时间：${timestamp}`} aria-label={`发送时间：${timestamp}`}>
          {sentAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
        </time>
        <button type="button" aria-label="复制消息" title={copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，点击重试' : '复制消息'}
          onClick={() => void copy()} onBlur={() => setCopyState('idle')}>
          <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} />
        </button>
        <button type="button" ref={editButton} aria-label="编辑消息" title={canEdit ? '编辑消息' : '旧对话仅供查看'} disabled={!canEdit || busy}
          onClick={() => { if (!editing) { setDraft(message.text); setEditing(true); } }}><Icon name="edit" size={14} /></button>
      </div>
    </div>
    {editing ? <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea aria-label="编辑消息内容" autoFocus rows={4} value={draft} disabled={busy} maxLength={100_000}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
        }} />
      <small>修改后将作为新消息发送，原记录保留。</small>
      <div className={styles.editorActions}><button type="button" disabled={busy} onClick={cancel}>取消</button>
        <button type="submit" className={ui.primary} disabled={busy || !canEdit || !draft.trim() || draft.trim() === message.text.trim()}>{busy ? '发送中…' : '发送修改'}</button></div>
    </form> : <p>{message.text}</p>}
    <span className={styles.copyStatus} role="status">{copyState === 'copied' ? '消息已复制' : copyState === 'failed' ? '复制失败，请重试或手动选择消息。' : ''}</span>
  </article>;
}
