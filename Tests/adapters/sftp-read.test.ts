import { expect, it, vi } from 'vitest';
import type { SFTPWrapper } from 'ssh2';
import { readBoundedSftpFile } from '../../packages/adapters/src/sftp-read.js';

function fixture(data: Buffer, options: { regular?: boolean; size?: number; afterRead?: () => void; count?: number } = {}) {
  const handle = Buffer.from('synthetic-handle');
  const open = vi.fn((_path: string, _mode: string, callback: (error: undefined, value: Buffer) => void) => callback(undefined, handle));
  const fstat = vi.fn((_handle: Buffer, callback: (error: undefined, value: unknown) => void) => {
    callback(undefined, { isFile: () => options.regular ?? true, size: options.size ?? data.length });
  });
  const read = vi.fn((_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number,
    callback: (error: undefined, count: number) => void) => {
    const count = data.copy(buffer, offset, position, position + length); options.afterRead?.();
    callback(undefined, options.count ?? count);
  });
  const close = vi.fn((_handle: Buffer, callback: (error: undefined) => void) => callback(undefined));
  const readFile = vi.fn();
  return { open, fstat, read, close, readFile, channel: { open, fstat, read, close, readFile } as unknown as SFTPWrapper };
}

it('reads a bounded regular descriptor incrementally and closes it', async () => {
  const data = Buffer.alloc(150_000, 'x'), f = fixture(data);
  expect(await readBoundedSftpFile(f.channel, '/fixture', 200_000, () => {})).toEqual(data);
  expect(f.read.mock.calls.every((call) => call[3] <= 65_536)).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(4); expect(f.close).toHaveBeenCalledOnce(); expect(f.readFile).not.toHaveBeenCalled();
});

it.each([{ regular: false }, { size: 9 }, { size: Number.NaN }, { size: -1 }])('rejects invalid descriptor metadata before reading: %j', (options) => {
  const f = fixture(Buffer.from('fixture'), options);
  return expect(readBoundedSftpFile(f.channel, '/fixture', 8, () => {})).rejects.toThrow('bounded regular file')
    .then(() => { expect(f.read).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); });
});

it('detects file growth without allocating from the remote-reported size', async () => {
  const f = fixture(Buffer.from('123456789'), { size: 8 });
  await expect(readBoundedSftpFile(f.channel, '/fixture', 8, () => {})).rejects.toThrow('read limit');
  expect(f.read.mock.calls[0]?.[1].length).toBe(9); expect(f.close).toHaveBeenCalledOnce();
});

it('rejects a server byte count larger than the supplied read buffer', async () => {
  const f = fixture(Buffer.from('data'), { count: 999_999 });
  await expect(readBoundedSftpFile(f.channel, '/fixture', 8, () => {})).rejects.toThrow('read limit');
  expect(f.close).toHaveBeenCalledOnce();
});

it('rejects a shortened file instead of silently accepting a partial backup', async () => {
  const f = fixture(Buffer.from('data'), { size: 8 });
  await expect(readBoundedSftpFile(f.channel, '/fixture', 8, () => {})).rejects.toThrow('changed during read');
  expect(f.close).toHaveBeenCalledOnce();
});

it('checks revocation before open and between bounded read chunks', async () => {
  const closed = fixture(Buffer.from('data'));
  await expect(readBoundedSftpFile(closed.channel, '/fixture', 8, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(closed.open).not.toHaveBeenCalled();
  let active = true;
  const f = fixture(Buffer.alloc(150_000), { afterRead: () => { active = false; } });
  await expect(readBoundedSftpFile(f.channel, '/fixture', 200_000, () => {
    if (!active) throw new Error('revoked');
  })).rejects.toThrow('revoked');
  expect(f.read).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
