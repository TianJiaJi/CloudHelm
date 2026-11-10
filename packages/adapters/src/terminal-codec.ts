import iconv from 'iconv-lite';
import type { SshConnectionSettings } from '@cloudhelm/core';

type Encoding = NonNullable<NonNullable<SshConnectionSettings['terminal']>['encoding']>;
const supported = new Set<Encoding>(['utf8', 'gb18030', 'gbk', 'big5', 'shift_jis', 'windows-1252', 'latin1']);

/** Human terminal bytes only; never apply a locale codec to the Agent's fixed
 * UTF-8 control protocol. Reject lossy input rather than changing commands to '?'. */
export function createTerminalCodec(encoding: Encoding = 'utf8') {
  if (!supported.has(encoding) || !iconv.encodingExists(encoding)) throw new Error('Unsupported terminal encoding');
  const decoder = iconv.getDecoder(encoding, { stripBOM: false });
  return {
    write: (bytes: Buffer): string => decoder.write(bytes),
    end: (): string => decoder.end() ?? '',
    decode: (bytes: Buffer): string => iconv.decode(bytes, encoding, { stripBOM: false }),
    encode: (text: string): Buffer => {
      const bytes = iconv.encode(text, encoding);
      if (iconv.decode(bytes, encoding, { stripBOM: false }) !== text) throw new Error('当前终端编码无法无损表示输入，未发送；请改用 UTF-8 或检查文本');
      return bytes;
    }
  };
}
