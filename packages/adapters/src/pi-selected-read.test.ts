import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSelectedReadTool } from './pi-selected-read.js';

type Page = { sha256: string; nextByteOffset: number; more: boolean; byteOffset: number; longLine?: boolean };
const payload = (result: Awaited<ReturnType<ReturnType<typeof createSelectedReadTool>['execute']>>) => {
  const text = result.content[0]!.text;
  return text.slice(text.indexOf('\n') + 1);
};

describe('bounded read paging with host authorization', () => {
  it('pages files larger than the old 128 KiB limit and uses SDK truncation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cloudhelm-read-')));
    const path = join(root, 'selected.txt');
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => `${i + 1}: ${'a'.repeat(40)}`).join('\n'));
    await writeFile(path, data);
    try {
      const read = vi.fn(async (requested) => { if (requested !== path) throw new Error('outside selected scope'); return { data }; });
      const tool = createSelectedReadTool(read);
      const page = await tool.execute('page', { path, offset: 4999, limit: 2 });
      expect(page.content[0]?.text).toContain('4999:');
      expect(page.content[0]?.text).toContain('5000:');
      expect(page.content[0]?.text).not.toContain('4998:');
      const truncated = await tool.execute('all', { path });
      expect(truncated.content[0]!.text.length).toBeLessThan(55_000);
      expect(truncated.content[0]!.text).toContain('offset=');
      await expect(tool.execute('escape', { path: join(root, 'private.txt') })).rejects.toThrow('outside');
      await expect(tool.execute('relative', { path: 'selected.txt' })).rejects.toThrow('absolute');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('offers a byte cursor instead of an unavailable shell for an oversized first line', async () => {
    const path = join(tmpdir(), 'selected-long-line.txt');
    const data = Buffer.from(`head\n${'中🙂'.repeat(12000)}\ntail`);
    const tool = createSelectedReadTool(async () => ({ data }));
    const result = await tool.execute('long', { path, offset: 2 });
    expect(result.content[0]!.text).not.toMatch(/Use bash|sed -n|head -c/u);
    expect(result.details).toMatchObject({ longLine: true, more: true, nextByteOffset: 5,
      sha256: createHash('sha256').update(data).digest('hex') });
    expect(result.content[0]!.text).toContain('byteOffset=5');
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(50 * 1024);
  });

  it('reconstructs UTF-8 byte pages without gaps, duplicates or split code points and authorizes every page', async () => {
    const path = join(tmpdir(), 'selected-unicode.txt');
    const data = Buffer.from('中文🙂abc\n'.repeat(50));
    const read = vi.fn(async () => ({ data }));
    const tool = createSelectedReadTool(read);
    let byteOffset = 0;
    let expectedSha256: string | undefined;
    let calls = 0;
    const parts: string[] = [];
    for (;;) {
      const result = await tool.execute(`page-${calls++}`, { path, byteOffset, byteLimit: 7, expectedSha256 });
      const page = result.details as Page;
      expect(page.byteOffset).toBe(byteOffset);
      const text = payload(result);
      expect(text).not.toContain('\uFFFD');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(7);
      parts.push(text);
      expectedSha256 = page.sha256;
      if (!page.more) break;
      expect(page.nextByteOffset).toBeGreaterThan(byteOffset);
      byteOffset = page.nextByteOffset;
      expect(calls).toBeLessThan(300);
    }
    expect(parts.join('')).toBe(data.toString('utf8'));
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('bounds the entire response including metadata even when byteLimit requests the maximum', async () => {
    const data = Buffer.from('中'.repeat(30000));
    const tool = createSelectedReadTool(async () => ({ data }));
    const result = await tool.execute('max', { path: join(tmpdir(), 'large.txt'), byteOffset: 0, byteLimit: 51200 });
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(51200);
    expect(payload(result)).not.toContain('\uFFFD');
    expect(result.details).toMatchObject({ more: true });
  });

  it('rejects changed files and revoked authorization on continuation instead of using cached contents', async () => {
    const path = join(tmpdir(), 'selected.txt');
    let data = Buffer.from('old contents');
    let allowed = true;
    const tool = createSelectedReadTool(async () => {
      if (!allowed) throw new Error('outside selected scope');
      return { data };
    });
    const first = await tool.execute('first', { path, byteOffset: 0, byteLimit: 4 });
    const page = first.details as Page;
    data = Buffer.from('new contents');
    await expect(tool.execute('changed', { path, byteOffset: page.nextByteOffset, expectedSha256: page.sha256 }))
      .rejects.toThrow(/changed|版本/u);
    allowed = false;
    await expect(tool.execute('revoked', { path, byteOffset: page.nextByteOffset, expectedSha256: page.sha256 }))
      .rejects.toThrow('outside');
  });

  it.each([{ offset: 1, byteOffset: 0 }, { limit: 1, byteLimit: 10 }, { offset: 0 }, { limit: -1 },
    { byteOffset: -1 }, { byteOffset: 0.5 }, { byteLimit: 1 }, { byteLimit: 51201 }, { expectedSha256: 'bad' }])('rejects ambiguous or invalid paging arguments %j', async (args) => {
      const tool = createSelectedReadTool(async () => ({ data: Buffer.from('content') }));
      await expect(tool.execute('invalid', { path: join(tmpdir(), 'selected.txt'), ...args })).rejects.toThrow();
    });

  it('handles EOF/empty files and rejects an interior UTF-8 offset or an offset beyond EOF', async () => {
    const path = join(tmpdir(), 'selected.txt');
    const tool = createSelectedReadTool(async () => ({ data: Buffer.from('中') }));
    await expect(tool.execute('split', { path, byteOffset: 1 })).rejects.toThrow(/UTF-8/u);
    await expect(tool.execute('past', { path, byteOffset: 4 })).rejects.toThrow(/end|EOF/u);
    const eof = await tool.execute('eof', { path, byteOffset: 3 });
    expect(eof.details).toMatchObject({ more: false, nextByteOffset: 3 });
    expect(payload(eof)).toBe('');
    const empty = await createSelectedReadTool(async () => ({ data: Buffer.alloc(0) })).execute('empty', { path });
    expect(empty.details).toMatchObject({ more: false, nextByteOffset: 0 });
  });

  it('does not return file data when cancelled before or during the authorized read', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => { controller.abort(); return { data: Buffer.from('content') }; });
    const tool = createSelectedReadTool(read);
    const args = { path: join(tmpdir(), 'selected.txt') };
    await expect(tool.execute('during', args, controller.signal)).rejects.toThrow(/abort/iu);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(tool.execute('before', args, controller.signal)).rejects.toThrow(/abort/iu);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([Buffer.from([0]), Buffer.from([0xff, 0xfe]), Buffer.alloc(1_048_577, 97)])('rejects binary, invalid UTF-8 and oversized content', async (data) => {
    const tool = createSelectedReadTool(async () => ({ data }));
    await expect(tool.execute('read', { path: '/selected/file' })).rejects.toThrow();
  });
});
