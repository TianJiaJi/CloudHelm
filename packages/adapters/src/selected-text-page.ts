import { createHash } from 'node:crypto';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const MAX_PAGE_BYTES = 50 * 1024;
const PAYLOAD_BYTES = MAX_PAGE_BYTES - 1024;
export const selectedReadParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096, description: 'Absolute user-selected local path' }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: '1-based line offset; not combined with byte paging' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: 'Maximum lines, at most 2000' })),
  byteOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_048_576, description: '0-based UTF-8 boundary; use the returned nextByteOffset' })),
  byteLimit: Type.Optional(Type.Integer({ minimum: 4, maximum: MAX_PAGE_BYTES, description: 'Byte paging only, 4–51200 bytes; metadata also shares the page budget' })),
  expectedSha256: Type.Optional(Type.String({ pattern: '^[a-fA-F0-9]{64}$', description: 'Bind continuation to the previously returned file version' }))
}, { additionalProperties: false });
export type SelectedReadInput = Static<typeof selectedReadParameters>;

export function validateSelectedRead(input: SelectedReadInput): void {
  if (!Value.Check(selectedReadParameters, input) || (input.offset !== undefined && !Number.isSafeInteger(input.offset))) {
    throw new Error('Invalid selected read arguments: use integer line or byte bounds and a SHA-256 file version');
  }
  if ((input.byteOffset !== undefined || input.byteLimit !== undefined) && (input.offset !== undefined || input.limit !== undefined)) {
    throw new Error('Choose offset/limit OR byteOffset/byteLimit, not both');
  }
}

export interface SelectedTextPage {
  kind: 'selected-text'; version: 1; mode: 'lines' | 'bytes'; sha256: string;
  totalBytes: number; byteOffset: number; bytesReturned: number; nextByteOffset: number;
  more: boolean; truncated: boolean; offset?: number; nextOffset?: number; linesReturned?: number;
  longLine?: boolean; guidance?: string;
}

/** The source buffer has already passed full UTF-8, size and authorization checks.
 * Offsets always refer to this exact source version, never to the rendered header. */
export function selectedTextPage(data: Buffer, args: SelectedReadInput) {
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (args.expectedSha256 && args.expectedSha256.toLowerCase() !== sha256) {
    throw new Error('Selected file changed; start a new read and use its SHA-256 version');
  }
  const base = { kind: 'selected-text' as const, version: 1 as const, sha256, totalBytes: data.length };
  let body: string;
  let details: SelectedTextPage;
  if (args.byteOffset !== undefined || args.byteLimit !== undefined) {
    const start = args.byteOffset ?? 0;
    if (start > data.length) throw new Error('byteOffset is beyond the end of file');
    if (start < data.length && (data[start]! & 0xc0) === 0x80) {
      throw new Error('byteOffset must be a UTF-8 character boundary; use nextByteOffset');
    }
    let end = Math.min(data.length, start + Math.min(args.byteLimit ?? PAYLOAD_BYTES, PAYLOAD_BYTES));
    while (end > start && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
    body = data.subarray(start, end).toString('utf8');
    const more = end < data.length;
    details = { ...base, mode: 'bytes', byteOffset: start, bytesReturned: end - start, nextByteOffset: end, more, truncated: more,
      ...(more ? { guidance: `Continue with byteOffset=${end} and expectedSha256=${sha256}.` } : {}) };
  } else {
    const lines = data.toString('utf8').split('\n');
    const start = (args.offset ?? 1) - 1;
    if (start >= lines.length) throw new Error(`Line offset is beyond the end of file (${lines.length} lines)`);
    const byteAt = (line: number) => line >= lines.length ? data.length
      : Math.min(data.length, Buffer.byteLength(lines.slice(0, line).join('\n')) + (line ? 1 : 0));
    const selected = lines.slice(start, start + (args.limit ?? 2000));
    const truncated = truncateHead(selected.join('\n'), { maxLines: 2000, maxBytes: PAYLOAD_BYTES });
    body = truncated.content;
    if (truncated.firstLineExceedsLimit) {
      const nextByteOffset = byteAt(start);
      details = { ...base, mode: 'lines', offset: start + 1, byteOffset: nextByteOffset, bytesReturned: 0,
        nextByteOffset, linesReturned: 0, more: true, truncated: true, longLine: true,
        guidance: `Line exceeds the page budget. Use byteOffset=${nextByteOffset} and byteLimit=51200 with expectedSha256=${sha256}.` };
    } else {
      const count = truncated.truncated ? truncated.outputLines : selected.length;
      const end = byteAt(start + count);
      const more = end < data.length;
      details = { ...base, mode: 'lines', offset: start + 1, byteOffset: byteAt(start), bytesReturned: Buffer.byteLength(body),
        nextByteOffset: end, linesReturned: count, more, truncated: more,
        ...(more ? { nextOffset: start + count + 1, guidance: `Continue with offset=${start + count + 1} and expectedSha256=${sha256}.` } : {}) };
    }
  }
  const text = `[Selected file page ${JSON.stringify(details)}]\n${body}`;
  if (Buffer.byteLength(text) > MAX_PAGE_BYTES) throw new Error('Selected file page exceeds its bounded output budget');
  return { content: [{ type: 'text' as const, text }], details };
}
