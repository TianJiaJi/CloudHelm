import type { ContextMenuEntry } from './context-menu.js';

/**
 * Clipboard helpers for user-initiated menu actions. Contents are never
 * written to logs, audit text or the model context.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await window.cloudhelm.writeClipboard(text);
      return true;
    } catch {
      return false;
    }
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return window.cloudhelm.readClipboard();
  }
}

/** Inserts pasted text at the caret of a native field and keeps React in sync. */
export function insertFieldText(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Copy entries for a text surface. A live selection is offered first because
 * that is what a right-click almost always means.
 */
export function copyEntries(label: string, text: string, report?: (message: string) => void): ContextMenuEntry[] {
  const selection = typeof window === 'undefined' ? '' : window.getSelection()?.toString().trim() ?? '';
  const run = (value: string): void => {
    void copyText(value).then((ok) => { if (!ok) report?.('无法访问剪贴板，请重试或手动选择内容。'); });
  };
  const entries: ContextMenuEntry[] = [];
  if (selection) entries.push({ id: 'copy-selection', label: '复制选中内容', icon: 'copy', run: () => run(selection) });
  entries.push({ id: 'copy-text', label, icon: 'copy', run: () => run(text), disabled: !text });
  return entries;
}
