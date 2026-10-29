import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BusinessTool } from '@cloudhelm/core';
import type { LocalScope } from '@cloudhelm/contracts';
import type { SafetyGate } from '@cloudhelm/application';
import { LocalFileAccess } from '../../../apps/desktop/src/worker/local-file-access.js';
import { createRemoteTools } from '../../../apps/desktop/src/worker/remote-tools.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

it('wires real authorized file/directory pages through business tools without local or remote execution', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cloudhelm-local-tools-')));
  const scopes: LocalScope[] = [{ path: root, kind: 'directory' }];
  const remote = vi.fn(() => { throw new Error('No remote execution belongs in this fixture'); });
  const tools = createRemoteTools({ hosts: [], localFiles: new LocalFileAccess(scopes),
    ensureTerminal: remote, scope: remote, runOperation: remote } as unknown as RemoteToolDependencies, {} as SafetyGate);
  const list = tools.find((tool) => tool.name === 'list_selected_directory') as BusinessTool<{ path: string; cursor?: string }>;
  const read = tools.find((tool) => tool.name === 'read_selected_text_file') as BusinessTool<{
    path: string; byteOffset?: number; byteLimit?: number; expectedSha256?: string;
  }>;
  try {
    const names = Array.from({ length: 201 }, (_, i) => `${String(i).padStart(3, '0')}-${'中'.repeat(85)}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(root, name), 'hello🙂')));
    const first = await list.execute('list-first', { path: root });
    const header = first.details as { nextCursor: string; more: boolean; entriesReturned: number; totalEntries: number };
    expect(header).toMatchObject({ more: true, totalEntries: 201 });
    expect(header.entriesReturned).toBeLessThan(200); // Byte budget binds before the entry cap.
    expect(Buffer.byteLength(first.content[0]!.text)).toBeLessThanOrEqual(50 * 1024);
    expect(first.content[0]!.text.slice(0, 2000)).toContain(header.nextCursor);
    const last = await list.execute('list-last', { path: root, cursor: header.nextCursor });
    expect(last.details).toMatchObject({ more: false, entriesReturned: 201 - header.entriesReturned });
    const entries = [first, last].flatMap((result) => {
      const text = result.content[0]!.text;
      return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Array<{ name: string }>;
    });
    expect(entries.map((entry) => entry.name)).toEqual(names);
    const file = path.join(root, names[0]!);
    const page = await read.execute('read-first', { path: file, byteOffset: 0, byteLimit: 7 });
    const version = page.details as { nextByteOffset: number; sha256: string };
    expect(version.nextByteOffset).toBe(5);
    const tail = await read.execute('read-last', { path: file, byteOffset: version.nextByteOffset, expectedSha256: version.sha256 });
    expect(tail.content[0]!.text.endsWith('\n🙂')).toBe(true);
    scopes.splice(0);
    const denied = await list.execute('list-revoked', { path: root, cursor: header.nextCursor });
    expect(denied.isError).toBe(true);
    await expect(read.execute('read-revoked', { path: file, byteOffset: 5 })).rejects.toThrow('outside');
    expect(remote).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
