import { createHash } from 'node:crypto';
import { OutputRedactor } from './redaction.js';

export const FILE_EDIT_MAX_BYTES = 1_048_576;
export const FILE_EDIT_DIFF_MAX_BYTES = 65_536;
const MAX_LINES = 32_768;
export interface FileEditSource { content: string; truncated: boolean; redacted?: boolean; sha256?: string }
type RefusalCode = 'remote-edit-source-changed' | 'remote-edit-ambiguous' | 'remote-edit-invalid'
  | 'remote-edit-unavailable' | 'remote-edit-diff-too-large';
export type FileEditPreview = { kind: 'prepared'; content: string; sourceSha256: string; targetSha256: string; diff: string }
  | { kind: 'refused'; code: RefusalCode; message: string };
const refuse = (code: RefusalCode, message: string): FileEditPreview => ({ kind: 'refused', code, message });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const validText = (text: string) => !text.includes('\0') && Buffer.from(text).toString('utf8') === text;
function safeText(text: string): boolean {
  const redactor = new OutputRedactor(FILE_EDIT_MAX_BYTES);
  return redactor.push(text) + redactor.finish() === text;
}
function lines(text: string): string[] | undefined {
  if (!text) return [];
  const parts = text.split('\n', MAX_LINES + 1);
  if (parts.length > MAX_LINES) return undefined;
  const terminated = text.endsWith('\n');
  if (terminated) parts.pop();
  return parts.map((line, index) => line + (terminated || index < parts.length - 1 ? '\n' : ''));
}

/** One literal replacement needs no quadratic general diff algorithm. Keep every
 * changed line, three context lines, and exact CRLF/EOF semantics. Never clip. */
function unifiedDiff(source: string, target: string): string | undefined {
  const before = lines(source), after = lines(target);
  if (!before || !after) return undefined;
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), context = Math.min(3, suffix);
  const oldEnd = before.length - suffix, newEnd = after.length - suffix;
  const oldCount = oldEnd + context - start, newCount = newEnd + context - start;
  const output = ['--- before\n+++ after\n',
    `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@\n`];
  let bytes = output.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
  const emit = (tag: string, line: string): boolean => {
    const part = tag + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
    bytes += Buffer.byteLength(part);
    if (bytes > FILE_EDIT_DIFF_MAX_BYTES) return false;
    output.push(part); return true;
  };
  for (let i = start; i < prefix; i++) if (!emit(' ', before[i]!)) return undefined;
  for (let i = prefix; i < oldEnd; i++) if (!emit('-', before[i]!)) return undefined;
  for (let i = prefix; i < newEnd; i++) if (!emit('+', after[i]!)) return undefined;
  for (let i = oldEnd; i < oldEnd + context; i++) if (!emit(' ', before[i]!)) return undefined;
  return output.join('');
}

/** Pure preparation only: neither version hashes nor the diff authorize a write,
 * hold a remote lock, preserve metadata, or establish an execution identity. */
export function prepareFileEdit(snapshot: FileEditSource, expectedSha256: string, oldText: string, newText: string): FileEditPreview {
  const source = snapshot.content;
  if (snapshot.truncated || !snapshot.sha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256)
    || Buffer.byteLength(source) > FILE_EDIT_MAX_BYTES || !validText(source)
    || snapshot.sha256 !== expectedSha256 || sha256(source) !== expectedSha256)
    return refuse('remote-edit-source-changed', 'Complete source version unavailable or changed; read it again. Nothing written.');
  if (snapshot.redacted || !safeText(source))
    return refuse('remote-edit-unavailable', 'A redacted or sensitive observation cannot prepare a whole-file replacement. Nothing written.');
  if (!oldText || Buffer.byteLength(oldText) > FILE_EDIT_MAX_BYTES || Buffer.byteLength(newText) > FILE_EDIT_MAX_BYTES || !validText(oldText) || !validText(newText))
    return refuse('remote-edit-invalid', 'Literal edit inputs must be bounded UTF-8 without NUL bytes. Nothing written.');
  const start = source.indexOf(oldText);
  if (start < 0 || source.indexOf(oldText, start + 1) !== -1)
    return refuse('remote-edit-ambiguous', 'oldText must match exactly one location, including overlapping matches. Nothing written.');
  const content = source.slice(0, start) + newText + source.slice(start + oldText.length);
  if (content === source || Buffer.byteLength(content) > FILE_EDIT_MAX_BYTES)
    return refuse('remote-edit-invalid', 'Replacement must change the file and fit within 1 MiB. Nothing written.');
  if (!safeText(content)) return refuse('remote-edit-unavailable', 'Proposed content needs redaction; use private or manual handling. Nothing written.');
  const diff = unifiedDiff(source, content);
  if (diff === undefined) return refuse('remote-edit-diff-too-large', 'Complete diff exceeds 64 KiB or the 32768-line work limit. No partial preview or write was produced.');
  return { kind: 'prepared', content, sourceSha256: expectedSha256, targetSha256: sha256(content), diff };
}
