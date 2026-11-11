import type { MessagePart } from '@cloudhelm/contracts';

const marker = 'data-cloudhelm-reference-parts';
/** A second representation of the same clipboard item; only escaped text, never executable HTML. */
export function referenceClipboardHtml(parts: MessagePart[], text: string): string {
  const encoded = encodeURIComponent(JSON.stringify(parts));
  const escaped = text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return `<span ${marker}="${encoded}">${escaped}</span>`;
}

/** Read only our exact envelope, without parsing/inserting arbitrary HTML or fetching its resources. */
export function referenceClipboardPayload(clipboard: Pick<DataTransfer, 'getData'>): string | undefined {
  const direct = clipboard.getData('application/x-cloudhelm-parts');
  if (direct) return direct;
  const html = clipboard.getData('text/html');
  if (!html.includes(marker)) return undefined;
  const pattern = /<span data-cloudhelm-reference-parts="([^"]*)">/gu;
  const match = pattern.exec(html);
  if (!match || pattern.exec(html)) throw new Error('内部引用剪贴板格式无效，请重新复制');
  try { return decodeURIComponent(match[1]!); }
  catch { throw new Error('内部引用剪贴板编码无效，请重新复制'); }
}
