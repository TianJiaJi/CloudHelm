import { expect, it } from 'vitest';
import type { MessagePart } from '@cloudhelm/contracts';
import { referenceClipboardHtml, referenceClipboardPayload } from '../../../apps/desktop/src/renderer/reference-clipboard.js';

const parts: MessagePart[] = [{ type: 'reference', reference: { id: 'synthetic', kind: 'terminal', capturedAt: 1, command: '中 <>& "' } }];
const clipboard = (html: string, direct = '') => ({ getData: (type: string) => type === 'text/html' ? html : type === 'application/x-cloudhelm-parts' ? direct : 'ordinary fallback' });
it('round trips canonical reference metadata while escaping executable-looking terminal output', () => {
  const html = referenceClipboardHtml(parts, '<img src="https://example.invalid" onerror="bad()"><script>bad()</script>&');
  expect(html).not.toContain('<img'); expect(html).not.toContain('<script'); expect(html).toContain('&amp;');
  expect(JSON.parse(referenceClipboardPayload(clipboard(`<!--StartFragment-->${html}<!--EndFragment-->`))!)).toEqual(parts);
});
it('does not mistake an escaped envelope in the terminal body for a second metadata envelope', () => {
  const inner = referenceClipboardHtml([], 'synthetic');
  const html = referenceClipboardHtml(parts, inner);
  expect(JSON.parse(referenceClipboardPayload(clipboard(html))!)).toEqual(parts);
});
it('rejects malformed or ambiguous internal envelopes rather than silently using plaintext', () => {
  expect(() => referenceClipboardPayload(clipboard('<span data-cloudhelm-reference-parts="%xx">bad</span>'))).toThrow('编码无效');
  expect(() => referenceClipboardPayload(clipboard('data-cloudhelm-reference-parts="broken"'))).toThrow('格式无效');
  const html = referenceClipboardHtml(parts, 'text');
  expect(() => referenceClipboardPayload(clipboard(html + html))).toThrow('格式无效');
});
it('leaves ordinary external HTML alone and prefers the native custom representation', () => {
  expect(referenceClipboardPayload(clipboard('<img src="https://example.invalid"><p>text</p>'))).toBeUndefined();
  expect(referenceClipboardPayload(clipboard('unparsed', JSON.stringify(parts)))).toBe(JSON.stringify(parts));
});
