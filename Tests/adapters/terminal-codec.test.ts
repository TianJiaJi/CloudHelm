import { expect, it } from 'vitest';
import { createTerminalCodec } from '../../packages/adapters/src/terminal-codec.js';

it.each([
  ['utf8', '中文🙂'], ['gb18030', '中文🙂'], ['gbk', '中文'], ['big5', '繁體中文'],
  ['shift_jis', '日本語'], ['windows-1252', 'café €'], ['latin1', 'café']
] as const)('round-trips %s and preserves multibyte output across every byte split', (encoding, text) => {
  const encoder = createTerminalCodec(encoding), bytes = encoder.encode(text);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = createTerminalCodec(encoding);
    expect(decoder.write(bytes.subarray(0, split)) + decoder.write(bytes.subarray(split)) + decoder.end()).toBe(text);
  }
  const bytewise = createTerminalCodec(encoding);
  expect([...bytes].map((byte) => bytewise.write(Buffer.from([byte]))).join('') + bytewise.end()).toBe(text);
  expect(encoder.decode(bytes)).toBe(text);
});
it.each(['gbk', 'big5', 'shift_jis', 'windows-1252', 'latin1'] as const)('refuses lossy %s input instead of turning an argument into question marks', (encoding) => {
  expect(() => createTerminalCodec(encoding).encode('rm filename🙂')).toThrow('未发送');
});
it('uses known GBK bytes and does not alter control sequences', () => {
  const codec = createTerminalCodec('gbk'); expect(codec.encode('中文').toString('hex')).toBe('d6d0cec4');
  const controls = '\x1b[31m\r\n\x03'; expect(codec.decode(codec.encode(controls))).toBe(controls);
});
it('keeps native UTF-8 as the default without removing a literal BOM in user input', () => {
  const codec = createTerminalCodec(); expect(codec.encode('\uFEFFvalue')).toEqual(Buffer.from('\uFEFFvalue'));
});
