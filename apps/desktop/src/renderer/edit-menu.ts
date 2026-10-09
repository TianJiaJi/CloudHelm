import type { ContextMenuEntry } from './context-menu.js';
import { insertFieldText, readClipboardText } from './clipboard.js';
import { bindingLabel, type ShortcutBindings } from './shortcuts.js';

export function editableTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>('input, textarea, [contenteditable="true"]') : null;
}

/** Secret and one-time-code fields never offer clipboard read or write. */
export function isSensitiveField(target: HTMLElement | null): boolean {
  return !!target?.closest('[data-sensitive-input="true"]');
}

function selectedText(field: HTMLElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    return end > start ? field.value.slice(start, end) : '';
  }
  return window.getSelection()?.toString() ?? '';
}

function selectAll(field: HTMLElement): void {
  field.focus();
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
  else document.execCommand('selectAll');
}

async function paste(field: HTMLElement): Promise<void> {
  field.focus();
  const text = await readClipboardText();
  if (!text) return;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) insertFieldText(field, text);
  else if (field.dataset.messageEditor) field.dispatchEvent(new CustomEvent('cloudhelm-paste', { detail: text }));
  else document.execCommand('insertText', false, text);
}

/**
 * Clipboard and history commands for a native text field. Chromium keeps
 * `execCommand` for editing commands; paste is implemented over the clipboard
 * IPC because `execCommand('paste')` is disabled in a sandboxed renderer.
 */
export function editMenuEntries(field: HTMLElement, bindings: ShortcutBindings, isMac: boolean,
  report: (message: string) => void): ContextMenuEntry[] {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    if (field.disabled || field.readOnly) return [];
  }
  const sensitive = isSensitiveField(field);
  const hasSelection = !!selectedText(field);
  const hint = (id: 'edit.copy' | 'edit.paste' | 'edit.cut' | 'edit.selectAll' | 'edit.undo' | 'edit.redo'): string =>
    bindingLabel(id, bindings, isMac);
  const copy = (cut: boolean): void => {
    if (!document.execCommand(cut ? 'cut' : 'copy')) report(cut ? '无法剪切所选内容。' : '无法访问剪贴板，请重试或手动选择内容。');
  };
  const entries: ContextMenuEntry[] = [
    { id: 'undo', label: '撤销', hint: hint('edit.undo'), run: () => { field.focus(); if (field.dataset.messageEditor) field.dispatchEvent(new CustomEvent('cloudhelm-edit', { detail: 'undo' })); else document.execCommand('undo'); } },
    { id: 'redo', label: '重做', hint: hint('edit.redo'), run: () => { field.focus(); if (field.dataset.messageEditor) field.dispatchEvent(new CustomEvent('cloudhelm-edit', { detail: 'redo' })); else document.execCommand('redo'); } },
    { id: 'd1', separator: true }
  ];
  if (!sensitive) {
    entries.push({ id: 'cut', label: '剪切', hint: hint('edit.cut'), disabled: !hasSelection, run: () => copy(true) },
      { id: 'copy', label: '复制', hint: hint('edit.copy'), disabled: !hasSelection, run: () => copy(false) });
  }
  entries.push({ id: 'paste', label: '粘贴', hint: hint('edit.paste'), run: () => void paste(field).catch(() => report('无法读取剪贴板。')) },
    { id: 'selectAll', label: '全选', hint: hint('edit.selectAll'), run: () => selectAll(field) });
  return entries;
}
