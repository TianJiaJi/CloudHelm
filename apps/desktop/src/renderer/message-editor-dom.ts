import type { MessagePart } from '@cloudhelm/contracts';
import { normalizeParts } from './message-drafts.js';

export function readEditor(root: HTMLElement, parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = [];
  const references = new Map(parts.flatMap((part) => part.type === 'reference' ? [[part.instanceId ?? part.reference.id, part] as const] : []));
  function visit(node: Node): void {
    if (node instanceof HTMLElement && node.dataset.reference) {
      const part = references.get(node.dataset.reference); if (part) result.push(part); return;
    }
    if (node.nodeType === Node.TEXT_NODE) { result.push({ type: 'text', text: node.textContent ?? '' }); return; }
    if (node instanceof HTMLBRElement) { result.push({ type: 'text', text: '\n' }); return; }
    if (node instanceof HTMLElement && ['DIV', 'P'].includes(node.tagName) && result.length) result.push({ type: 'text', text: '\n' });
    for (const child of Array.from(node.childNodes)) visit(child);
  }
  for (const node of Array.from(root.childNodes)) visit(node);
  return normalizeParts(result);
}
function length(node: Node): number {
  if (node instanceof HTMLElement && node.dataset.reference) return 1;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node instanceof HTMLBRElement) return 1;
  return Array.from(node.childNodes).reduce((sum, child) => sum + length(child), 0);
}
export function editorSelection(root: HTMLElement): { start: number; end: number } | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
  function position(target: Node, offset: number): number {
    let result = target.nodeType === Node.TEXT_NODE ? offset : Array.from(target.childNodes).slice(0, offset).reduce((sum, child) => sum + length(child), 0);
    let current: Node | null = target;
    while (current && current !== root) {
      let sibling = current.previousSibling;
      while (sibling) { result += length(sibling); sibling = sibling.previousSibling; }
      current = current.parentNode;
    }
    return result;
  }
  const a = position(selection.anchorNode!, selection.anchorOffset), b = position(selection.focusNode!, selection.focusOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
export function restoreCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange();
  let remaining = offset;
  for (const node of Array.from(root.childNodes)) {
    const size = length(node);
    if (node.nodeType === Node.TEXT_NODE && remaining <= size) { range.setStart(node, remaining); remaining = -1; break; }
    if (remaining < size) { range.setStartBefore(node); remaining = -1; break; }
    remaining -= size;
  }
  if (remaining >= 0) { range.selectNodeContents(root); range.collapse(false); }
  else range.collapse(true);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
}
