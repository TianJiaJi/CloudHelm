import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessagePart, ReferenceBody } from '@cloudhelm/contracts';
import { copyText } from './clipboard.js';
import { Icon } from './ui-helpers.js';
import styles from './message-editor.module.css';

type ReferencePart = Extract<MessagePart, { type: 'reference' }>;
export function ReferencePreview({ part, editable = false, close, save, remove }: {
  part: ReferencePart; editable?: boolean; close(): void; save?(content: string): void; remove?(): void;
}): React.JSX.Element {
  const [body, setBody] = useState<ReferenceBody>();
  const [text, setText] = useState('');
  const [original, setOriginal] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const canEdit = editable && part.reference.kind === 'paste';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    let live = true;
    const load = part.content !== undefined ? Promise.resolve({ reference: part.reference, original: part.content }) : window.cloudhelm.readReference(part.reference.id);
    void load.then((body) => { if (live) { setBody(body); setText(body.original); } }).catch((error: unknown) => { if (live) setError(String(error)); });
    return () => { live = false; previous?.focus({ preventScroll: true }); };
  }, [part]);
  const shown = original ? body?.original : body?.summary ?? body?.original;
  // The theme tokens live on the app shell, not document.body.
  const portalTarget = document.getElementById('root')?.firstElementChild ?? document.body;
  return createPortal(<div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className={styles.preview} ref={dialog} role="dialog" aria-modal="true" aria-label={part.reference.kind === 'terminal' ? '终端引用预览' : '粘贴文本预览'} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea'));
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className={styles.previewHead}>
        <span className={styles.previewIcon}><Icon name={canEdit ? 'edit' : part.reference.kind === 'terminal' ? 'terminal' : 'file'} size={18} /></span>
        <div className={styles.previewTitle}><strong>{part.reference.kind === 'terminal' ? '终端引用' : '粘贴文本'}</strong><span>{canEdit ? '编辑后保存到这条引用' : '查看引用的原始内容'}</span></div>
        <button className={styles.iconButton} type="button" aria-label="关闭预览" onClick={close}><Icon name="close" size={16} /></button>
      </header>
      {body && <div className={styles.previewMeta}>{[body.reference.hostLabel, body.reference.command, new Date(body.reference.capturedAt).toLocaleString(), body.reference.running ? '尚未结束 · 引用时快照' : body.reference.running === false ? `已结束 · ${body.reference.exitCode === undefined ? '退出状态未知' : `退出码 ${body.reference.exitCode}`}` : '', `${body.original.split('\n').length} 行`].filter(Boolean).join(' · ')}</div>}
      {error && <p className={styles.previewNotice} role="alert">{error}</p>}
      {!body && !error && <p className={styles.previewNotice}>正在读取…</p>}
      {body?.summary && <div className={styles.previewTabs}><button type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>实际发送的总结</button><button type="button" aria-pressed={original} onClick={() => setOriginal(true)}>原文</button></div>}
      {body && <div className={styles.previewBody}>{canEdit ? <textarea aria-label="编辑粘贴内容" value={text} onChange={(event) => setText(event.target.value)} /> : <pre tabIndex={0}>{shown}</pre>}</div>}
      <footer className={styles.previewActions}>
        <div><button className={styles.secondaryButton} type="button" disabled={!body} onClick={() => void copyText(canEdit ? text : shown ?? '').then(setCopied)}><Icon name="copy" size={13} />{copied ? '已复制' : '复制内容'}</button>
          {remove && <button className={styles.removeButton} type="button" onClick={remove}>移除引用</button>}</div>
        <div><button className={styles.secondaryButton} type="button" onClick={close}>关闭</button>
          {canEdit && <button className={styles.primaryButton} type="button" disabled={!body} onClick={() => { save?.(text); close(); }}>保存</button>}</div>
      </footer>
    </div>
  </div>, portalTarget);
}
