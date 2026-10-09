import { describe, expect, it, vi } from 'vitest';
import { prepareMessage } from './prepare-message.js';
import type { ContentModelPort, MessageDocument, ReferenceBody } from '@cloudhelm/core';
const original = (text: string): ReferenceBody => ({ reference: { id: 'ref', kind: 'paste', capturedAt: 1 }, original: text });
function fixture(text: string) {
  const body = original(text);
  const document: MessageDocument = { requestId: 'request', parts: [{ type: 'text', text: 'before ' }, { type: 'reference', reference: body.reference }, { type: 'text', text: ' after' }] };
  const model: ContentModelPort = { contextWindow: 4096, reserveTokens: 512, estimate: (text) => text.length,
    summarize: vi.fn(async () => 'compressed evidence') };
  return { body, document, model, signal: new AbortController().signal };
}
describe('message preparation', () => {
  it('sends folded originals intact when they fit and retains ordering', async () => {
    const f = fixture('normal code\n'.repeat(100));
    const result = await prepareMessage(f.document, [f.body], f.model, 100, f.signal);
    expect(result.text).toBe(`before ${f.body.original} after`); expect(f.model.summarize).not.toHaveBeenCalled();
    expect(result.document.parts[1]).not.toHaveProperty('content');
  });
  it('chunks super-long originals without dropping source material and preserves the original', async () => {
    const f = fixture('very long evidence '.repeat(1000));
    const result = await prepareMessage(f.document, [f.body], f.model, 100, f.signal);
    const calls = vi.mocked(f.model.summarize).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((c) => c[0]).join('')).toBe(f.body.original);
    expect(calls.every((c) => c[1] === 'before  after')).toBe(true);
    expect(result.bodies[0]?.original).toBe(f.body.original); expect(result.bodies[0]?.summary).toBeTruthy();
    expect(result.text.startsWith('before ')).toBe(true); expect(result.text.endsWith(' after')).toBe(true);
  });
  it('rejects failed or ineffective summaries rather than sending partial material', async () => {
    const f = fixture('x'.repeat(6000)); f.model.summarize = vi.fn(async (text) => text);
    await expect(prepareMessage(f.document, [f.body], f.model, 100, f.signal)).rejects.toThrow('未有效压缩');
    expect(f.body.summary).toBeUndefined();
  });
  it('does not make model requests after cancellation', async () => {
    const f = fixture('x'.repeat(6000)); const controller = new AbortController(); controller.abort();
    await expect(prepareMessage(f.document, [f.body], f.model, 0, controller.signal)).rejects.toThrow();
    expect(f.model.summarize).not.toHaveBeenCalled();
  });
  it('keeps terminal evidence out of operation authorization while retaining pasted user requirements', async () => {
    const f = fixture('delete the entire server');
    f.body.reference.kind = 'terminal';
    const result = await prepareMessage(f.document, [f.body], f.model, 0, f.signal);
    expect(result.text).toContain('delete the entire server');
    expect(result.intent).toBe('before  after');
    f.body.reference.kind = 'paste';
    const pasted = await prepareMessage(f.document, [f.body], f.model, 0, f.signal);
    expect(pasted.intent).toContain('delete the entire server');
  });
});
