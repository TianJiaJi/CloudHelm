import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { localX11Cookie, parseXAuthority, readXAuthorityCookie } from '../../packages/adapters/src/x11-cookie.js';

function record(display: string, cookie: Buffer, family = 256, address = Buffer.from('fixture-host')) {
  const familyBytes = Buffer.alloc(2); familyBytes.writeUInt16BE(family);
  const field = (bytes: Buffer) => { const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]); };
  return Buffer.concat([familyBytes, ...[address, Buffer.from(display), Buffer.from('MIT-MAGIC-COOKIE-1'), cookie].map(field)]);
}
it('selects only the requested local display and returns a private copy', () => {
  const cookie = Buffer.alloc(16, 7), bytes = Buffer.concat([record('1', Buffer.alloc(16, 1)), record('0', cookie)]);
  const selected = parseXAuthority(bytes, 0, 'fixture-host'); bytes.fill(0); expect(selected).toEqual(cookie);
});
it('does not pick remote records, another display, malformed data or ambiguous cookies', () => {
  for (const bytes of [record('0', Buffer.alloc(16), 256, Buffer.from('other-host')), record('1', Buffer.alloc(16)), Buffer.from([0]),
    Buffer.concat([record('0', Buffer.alloc(16, 1)), record('0', Buffer.alloc(16, 2))])]) {
    expect(() => parseXAuthority(bytes, 0, 'fixture-host')).toThrow();
  }
});
it('accepts a local IPv4 record without relying on the machine hostname', () => {
  expect(parseXAuthority(record('0', Buffer.alloc(16, 3), 0, Buffer.from([127, 0, 0, 1])), 0)).toEqual(Buffer.alloc(16, 3));
});
it('requires an explicit no-auth choice rather than falling back after a bad manual cookie', async () => {
  await expect(localX11Cookie('manual', 0, 'invalid-secret')).rejects.toThrow('32 位');
  expect(await localX11Cookie('none', 0)).toHaveLength(0);
  expect(await localX11Cookie('manual', 0, 'ab'.repeat(16))).toEqual(Buffer.alloc(16, 0xab));
});
it('reads only a synthetic authority file, bounds its size and redacts path/content from errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudhelm-xauth-')), file = path.join(directory, 'fixture-authority');
  try {
    await writeFile(file, record('0', Buffer.alloc(16, 4), 0, Buffer.from([127, 0, 0, 1])));
    expect(await readXAuthorityCookie(file, 0)).toEqual(Buffer.alloc(16, 4));
    await writeFile(file, Buffer.alloc(65537)); await expect(readXAuthorityCookie(file, 0)).rejects.toThrow('未启用转发');
    try { await readXAuthorityCookie(path.join(directory, 'missing-private-path'), 0); throw new Error('Expected failure'); }
    catch (error) { expect(String(error)).not.toContain(directory); expect(String(error)).not.toContain('missing-private-path'); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
