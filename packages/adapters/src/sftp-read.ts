import type { SFTPWrapper, Stats } from 'ssh2';

/** Bounded descriptor reads. The caller owns the channel deadline/cancellation and path checks. */
export async function readBoundedSftpFile(sftp: SFTPWrapper, remotePath: string, maxBytes: number,
  assertActive: () => void): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1_048_576) throw new Error('Invalid SFTP read limit');
  assertActive();
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(remotePath, 'r', (error, value) => error ? reject(error) : resolve(value));
  });
  try {
    assertActive();
    const stat = await new Promise<Stats>((resolve, reject) => {
      sftp.fstat(handle, (error, value) => error ? reject(error) : resolve(value));
    });
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new Error('Remote read requires a bounded regular file');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      assertActive();
      // One extra byte detects growth beyond the limit without buffering the whole remote file.
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes - length + 1));
      const count = await new Promise<number>((resolve, reject) => {
        sftp.read(handle, buffer, 0, buffer.length, length, (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
      });
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length || length + count > maxBytes) {
        throw new Error('Remote file exceeded the read limit');
      }
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count)); length += count;
    }
    assertActive();
    if (length !== stat.size) throw new Error('Remote file changed during read');
    return Buffer.concat(chunks, length);
  } finally {
    await new Promise<void>((resolve, reject) => {
      sftp.close(handle, (error) => error ? reject(error) : resolve());
    });
  }
}
