import { expandedMessageText } from './message-copy.js';
import { copyText } from './clipboard.js';
import { useLayoutEffect, useRef, useState } from 'react';
import type { MessagePart } from '@cloudhelm/contracts';
import { draftFor, longPaste, partLength, replaceParts, useMessageDrafts } from './message-drafts.js';
import { editorSelection, readEditor, restoreCaret } from './message-editor-dom.js';
import { ReferencePreview } from './reference-preview.js';
import styles from './message-editor.module.css';

const EMPTY: MessagePart[] = [];
export function MessageEditor({ draftKey, disabled, placeholder, send, label = '给 AI 的消息' }: {
  draftKey: string; disabled: boolean; placeholder: string; send(): void; label?: string;
}): React.JSX.Element {
  const draft = useMessageDrafts((state) => state.drafts[draftKey]);
  const parts = draft?.parts ?? EMPTY;
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const undo = useRef<Array<{ parts: MessagePart[]; caret: number }>>([]);
  const redo = useRef<Array<{ parts: MessagePart[]; caret: number }>>([]);
  const rendered = useRef('');
  const externalRevision = useRef(draft?.revision ?? 0);
  const previousParts = useRef(parts);
  const [copyFailure, setCopyFailure] = useState('');
  const [preview, setPreview] = useState<Extract<MessagePart, { type: 'reference' }>>();
  function remember(): void { const value = draftFor(draftKey); undo.current.push({ parts: value.parts, caret: value.caret }); if (undo.current.length > 100) undo.current.shift(); redo.current = []; }
  function set(parts: MessagePart[], caret: number): void { useMessageDrafts.getState().set(draftKey, { parts, caret }); }
  function selection() { return editor.current && editorSelection(editor.current) || { start: draftFor(draftKey).caret, end: draftFor(draftKey).caret }; }
  function insert(inserted: MessagePart[]): void {
    if (disabled) return;
    const range = selection(); remember();
    set(replaceParts(draftFor(draftKey).parts, range.start, range.end, inserted), range.start + inserted.reduce((sum, part) => sum + partLength(part), 0));
  }
  function paste(text: string): void {
    if (!text) return;
    insert(longPaste(text) ? [{ type: 'reference', reference: { id: crypto.randomUUID(), kind: 'paste', capturedAt: Date.now() }, content: text }]
      : [{ type: 'text', text }]);
  }
  function history(back: boolean): void {
    const source = back ? undo : redo, target = back ? redo : undo;
    const value = source.current.pop(); if (!value || disabled) return;
    const current = draftFor(draftKey); target.current.push({ parts: current.parts, caret: current.caret }); set(value.parts, value.caret);
  }
  function saveCaret(): void { if (preview) return; const range = editor.current && editorSelection(editor.current); if (range) useMessageDrafts.getState().set(draftKey, { caret: range.end }); }
  useLayoutEffect(() => {
    const root = editor.current;
    if (!root || composing.current) return;
    if (externalRevision.current !== (draft?.revision ?? 0)) {
      undo.current.push({ parts: previousParts.current, caret: Math.max(0, (draft?.caret ?? 1) - 1) }); redo.current = [];
      externalRevision.current = draft?.revision ?? 0;
    }
    previousParts.current = parts;
    const signature = JSON.stringify([parts, disabled, draft?.compressingReference]);
    if (rendered.current === signature) return;
    const focused = root === document.activeElement;
    root.replaceChildren();
    for (const part of parts) {
      if (part.type === 'text') { root.append(document.createTextNode(part.text)); continue; }
      const chip = document.createElement('span');
      chip.className = styles.chip!; chip.contentEditable = 'false'; chip.dataset.reference = part.instanceId ?? part.reference.id;
      chip.tabIndex = 0; chip.setAttribute('role', 'button');
      const name = part.reference.kind === 'terminal' ? 'Terminal' : '粘贴文本';
      chip.setAttribute('aria-label', name);
      chip.textContent = name + (draft?.compressingReference === (part.instanceId ?? part.reference.id) ? ' · 正在压缩' : part.reference.summarized ? ' · 已压缩' : '');
      chip.title = [name, part.reference.hostLabel, part.reference.command, new Date(part.reference.capturedAt).toLocaleString()].filter(Boolean).join(' · ');
      if (!disabled) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.dataset.remove = part.reference.id; remove.setAttribute('aria-label', `移除 ${name}`); chip.append(remove);
      }
      root.append(chip);
    }
    rendered.current = signature;
    if (focused) restoreCaret(root, draftFor(draftKey).caret);
  }, [parts, disabled, draftKey, draft?.revision, draft?.caret, draft?.compressingReference]);
  useLayoutEffect(() => {
    const root = editor.current!;
    const beforeInput = (event: Event) => {
      const type = (event as InputEvent).inputType;
      if (type === 'historyUndo' || type === 'historyRedo') { event.preventDefault(); history(type === 'historyUndo'); }
      if (type === 'insertParagraph' || type === 'insertLineBreak') { event.preventDefault(); insert([{ type: 'text', text: '\n' }]); }
    };
    const pasted = (event: Event) => { paste((event as CustomEvent<string>).detail); };
    const edit = (event: Event) => { const kind = (event as CustomEvent<string>).detail; if (kind === 'undo' || kind === 'redo') history(kind === 'undo'); };
    root.addEventListener('beforeinput', beforeInput); root.addEventListener('cloudhelm-paste', pasted); root.addEventListener('cloudhelm-edit', edit);
    return () => { root.removeEventListener('beforeinput', beforeInput); root.removeEventListener('cloudhelm-paste', pasted); root.removeEventListener('cloudhelm-edit', edit); };
  });
  async function copy(event: React.ClipboardEvent, cut: boolean): Promise<void> {
    const range = selection(); if (range.start === range.end) return;
    event.preventDefault();
    const selected = replaceParts(replaceParts(parts, range.end, parts.reduce((n, p) => n + partLength(p), 0), []), 0, range.start, []);
    const allLoaded = selected.every((part) => part.type === 'text' || part.content !== undefined);
    event.clipboardData.setData('application/x-cloudhelm-parts', JSON.stringify(selected));
    let ok = true;
    if (allLoaded) event.clipboardData.setData('text/plain', selected.map((part) => part.type === 'text' ? part.text : part.content).join(''));
    else {
      try {
        const content = expandedMessageText(selected);
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content.then((text) => new Blob([text], { type: 'text/plain' })) })]);
        } else ok = await copyText(await content);
      } catch { ok = false; }
    }
    setCopyFailure(ok ? '' : '复制失败，请打开引用预览重试');
    if (cut && ok && !disabled && draftFor(draftKey).parts === parts) { remember(); set(replaceParts(parts, range.start, range.end, []), range.start); }

  }
  return <><div ref={editor} className={styles.editor} role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled}
    contentEditable={!disabled} suppressContentEditableWarning data-message-editor="true" data-placeholder={placeholder}
    onFocus={(event) => { if (event.target === event.currentTarget) restoreCaret(event.currentTarget, draftFor(draftKey).caret); }}
    onMouseDown={(event) => { if ((event.target as HTMLElement).closest('[data-reference]')) event.preventDefault(); }}
    onBlur={saveCaret} onKeyUp={saveCaret} onMouseUp={(event) => { if (!(event.target as HTMLElement).closest('[data-reference]')) saveCaret(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; const root = editor.current!; remember(); set(readEditor(root, parts), editorSelection(root)?.end ?? 0); }}
    onInput={() => { if (composing.current) return; const root = editor.current!; remember(); set(readEditor(root, parts), editorSelection(root)?.end ?? 0); }}
    onPaste={(event) => { event.preventDefault(); const internal = event.clipboardData.getData('application/x-cloudhelm-parts');
      if (internal) { try { const values = JSON.parse(internal) as MessagePart[]; if (Array.isArray(values) && values.every((p) => p.type === 'text' && typeof p.text === 'string' || p.type === 'reference' && p.reference?.id)) { insert(values.map((part) => part.type === 'reference' ? { ...part, instanceId: crypto.randomUUID() } : part)); return; } } catch { /* Plain-text fallback. */ } }
      paste(event.clipboardData.getData('text/plain')); }}
    onCopy={(event) => { void copy(event, false); }} onCut={(event) => { void copy(event, true); }}
    onClick={(event) => {
      const target = event.target as HTMLElement;
      const id = target.closest<HTMLElement>('[data-reference]')?.dataset.reference;
      const part = parts.find((part) => part.type === 'reference' && (part.instanceId ?? part.reference.id) === id);
      if (part?.type !== 'reference') return;
      if (target.dataset.remove && !disabled) { remember(); set(parts.filter((p) => p !== part), Math.max(0, draftFor(draftKey).caret - 1)); }
      else setPreview(part);
    }}
    onKeyDown={(event) => {
      if (disabled || composing.current || event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(!event.shiftKey); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); history(false); return; }
      if (event.key === 'Enter' && (event.target as HTMLElement).dataset.reference) { event.preventDefault(); (event.target as HTMLElement).click(); return; }
      if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) insert([{ type: 'text', text: '\n' }]); else send(); }
    }} />
    {copyFailure && <small role="status">{copyFailure}</small>}
    {preview && <ReferencePreview part={preview} editable={!disabled} close={() => setPreview(undefined)} remove={!disabled ? () => {
      remember(); set(parts.filter((part) => part !== preview), Math.max(0, draftFor(draftKey).caret - 1)); setPreview(undefined);
    } : undefined} save={(content) => {
      remember(); set(parts.map((part) => part === preview ? { ...preview, content, reference: { ...preview.reference, summarized: false } } : part), draftFor(draftKey).caret);
    }} />}
  </>;
}
