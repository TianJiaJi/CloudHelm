import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessagePart, ReferenceBody } from '@cloudhelm/contracts';
import { copyText } from './clipboard.js';
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
      <header><strong>{part.reference.kind === 'terminal' ? 'Terminal' : '粘贴文本'}</strong><button type="button" aria-label="关闭预览" onClick={close}>×</button></header>
      {body && <small>{[body.reference.hostLabel, body.reference.command, new Date(body.reference.capturedAt).toLocaleString(), body.reference.running ? '尚未结束 · 引用时快照' : body.reference.running === false ? `已结束 · ${body.reference.exitCode === undefined ? '退出状态未知' : `退出码 ${body.reference.exitCode}`}` : '', `${body.original.split('\n').length} 行`].filter(Boolean).join(' · ')}</small>}
      {error && <p role="alert">{error}</p>}
      {!body && !error && <p>正在读取…</p>}
      {body?.summary && <div className={styles.previewTabs}><button type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>实际发送的总结</button><button type="button" aria-pressed={original} onClick={() => setOriginal(true)}>原文</button></div>}
      {body && (canEdit ? <textarea aria-label="编辑粘贴内容" value={text} onChange={(event) => setText(event.target.value)} /> : <pre tabIndex={0}>{shown}</pre>)}
      <footer><button type="button" disabled={!body} onClick={() => void copyText(canEdit ? text : shown ?? '').then(setCopied)}>{copied ? '已复制' : '复制内容'}</button>
        <button type="button" onClick={close}>关闭</button>{remove && <button type="button" onClick={remove}>移除引用</button>}{canEdit && <button type="button" disabled={!body} onClick={() => { save?.(text); close(); }}>保存</button>}</footer>
    </div>
  </div>, document.body);
}
