import { open } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import path from 'node:path';

const protocol = 'MIT-MAGIC-COOKIE-1';

/** Xauthority is binary and contains secrets. Select only a local display record;
 * never stringify its contents, fall back to another display, or disable auth. */
export function parseXAuthority(bytes: Buffer, display: number, localHostname = hostname()): Buffer {
  let offset = 0; const matches: Buffer[] = [];
  const word = () => {
    if (offset + 2 > bytes.length) throw new Error('Invalid Xauthority record');
    const value = bytes.readUInt16BE(offset); offset += 2; return value;
  };
  const field = () => {
    const length = word(); if (offset + length > bytes.length) throw new Error('Invalid Xauthority record');
    const value = bytes.subarray(offset, offset + length); offset += length; return value;
  };
  while (offset < bytes.length) {
    const family = word(), address = field(), number = field(), name = field(), cookie = field();
    const local = family === 65535 || family === 256 && address.toString('utf8') === localHostname
      || family === 0 && address.equals(Buffer.from([127, 0, 0, 1]))
      || family === 6 && address.equals(Buffer.from('00000000000000000000000000000001', 'hex'));
    if (local && number.toString('ascii') === String(display) && name.toString('ascii') === protocol && cookie.length === 16) matches.push(cookie);
  }
  if (!matches.length || matches.some((cookie) => !cookie.equals(matches[0]!))) throw new Error('No unambiguous local X11 authentication cookie');
  return Buffer.from(matches[0]!);
}

export async function readXAuthorityCookie(filename: string, display: number): Promise<Buffer> {
  let bytes: Buffer | undefined;
  try {
    const file = await open(filename, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error('Invalid Xauthority file');
      // Bounded even if a file grows after stat. No personal file is read by tests.
      bytes = Buffer.alloc(65_537); let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break; length += result.bytesRead;
      }
      if (length > 65_536) throw new Error('Invalid Xauthority file');
      return parseXAuthority(bytes.subarray(0, length), display);
    } finally { await file.close(); }
  } catch { throw new Error('无法读取本机 X11 认证信息；请检查 Xauthority 或选择手动 Cookie，未启用转发'); }
  finally { bytes?.fill(0); }
}

export async function localX11Cookie(mode: 'auto' | 'manual' | 'none', display: number, manual?: string): Promise<Buffer> {
  if (mode === 'none') return Buffer.alloc(0); // Only an explicitly selected no-auth local X service.
  if (mode === 'manual') {
    if (!manual || !/^[a-f\d]{32}$/iu.test(manual)) throw new Error('X11 Cookie 必须是 32 位十六进制值');
    return Buffer.from(manual, 'hex');
  }
  return readXAuthorityCookie(process.env.XAUTHORITY || path.join(homedir(), '.Xauthority'), display);
}
