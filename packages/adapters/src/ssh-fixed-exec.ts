import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';

/** Fixed internal control/preflight commands only, never model shell input.
 * Includes channel allocation in the deadline and never retries a dispatch. */
export function runFixedSshCommand(client: Pick<Client, 'exec'>, command: string, isCurrent: () => boolean): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined, settled = false, output = '', exitCode = -1;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!error && !isCurrent()) error = new Error('SSH 检查的连接代次已变化；业务命令未发送');
      try { channel?.close(); } catch { /* The deadline/caller still gets a definite result. */ }
      if (error) reject(error); else resolve({ exitCode, output });
    };
    const timer = setTimeout(() => finish(new Error('远端环境检查超时；业务命令未发送')), 15_000);
    const append = (text: string) => {
      output = (output + text).slice(-4096);
      if (/^[\uDC00-\uDFFF]/u.test(output)) output = output.slice(1);
    };
    if (!isCurrent()) { finish(new Error('SSH 检查的连接代次已变化；业务命令未发送')); return; }
    try {
      client.exec(command, (error, stream) => {
        if (settled) { stream?.on('error', () => {}); stream?.close(); return; }
        channel = stream;
        stream?.on('error', (failure: Error) => finish(failure));
        if (error) { finish(error); return; }
        if (!isCurrent()) { finish(new Error('SSH 检查的连接代次已变化；业务命令未发送')); return; }
        stream.on('data', (data: Buffer) => { if (!settled) append(stdout.write(data)); });
        stream.stderr.on('data', (data: Buffer) => { if (!settled) append(stderr.write(data)); });
        stream.stderr.on('error', (failure: Error) => finish(failure));
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => { if (!settled) { append(stdout.end()); append(stderr.end()); finish(); } });
      });
    } catch (error) { finish(error instanceof Error ? error : new Error('SSH 检查未完成')); }
  });
}
