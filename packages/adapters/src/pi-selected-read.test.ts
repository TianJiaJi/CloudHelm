import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSelectedReadTool } from './pi-selected-read.js';

describe('native read paging with host authorization', () => {
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
  it.each([Buffer.from([0]), Buffer.from([0xff, 0xfe]), Buffer.alloc(1_048_577, 97)])('rejects binary, invalid UTF-8 and oversized content', async (data) => {
    const tool = createSelectedReadTool(async () => ({ data }));
    await expect(tool.execute('read', { path: '/selected/file' })).rejects.toThrow();
  });
});
