import { Duplex, PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { SshTransport } from './ssh-transport.js';
import type { CommandTransport } from './ssh-command-terminal.js';
import { suSessionProgram } from './su-session-program.js';

/** Isolated root broker. Only its authentication phase accepts secret answers. */
export class SuSession implements CommandTransport {
  private active?: ClientChannel;
  private broker?: ClientChannel;
  private program?: string;
  private ready = false;
  private closed = false;
  private challenge?: string;
  private readonly generation: number;
  private readonly abort = () => this.close();
  constructor(private readonly ssh: SshTransport, private readonly hostId: string,
    private readonly signal: AbortSignal, private readonly onClosed: () => void) {
    this.generation = ssh.connectionGeneration(hostId);
    signal.addEventListener('abort', this.abort, { once: true });
  }
  async connect(authenticate: (id: string) => Promise<string | null>, current: () => void): Promise<void> {
    current(); this.signal.throwIfAborted();
    this.program = await this.ssh.prepareCommandProgram(this.hostId, suSessionProgram, current);
    current(); this.signal.throwIfAborted();
    const broker = await this.ssh.openPipe(this.hostId, `python3 -I -u ${this.program}`);
    if (this.closed || this.signal.aborted) { broker.end(); broker.close(); throw new Error('Root session canceled'); }
    this.broker = broker;
    await new Promise<void>((resolve, reject) => {
      const decoder = new StringDecoder('utf8'); let buffer = ''; let settled = false;
      const timer = setTimeout(() => fail(), 125_000);
      const fail = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('su authentication failed or unsupported; no business command sent')); }
        this.close();
      };
      broker.on('close', fail); broker.on('error', fail); broker.stderr.on('data', fail);
      broker.on('data', (chunk: Buffer) => {
        if (this.closed) return;
        buffer += decoder.write(chunk);
        if (buffer.length > 1_048_576) { fail(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'ready' && event.uid === 0 && !this.ready) {
              current(); this.signal.throwIfAborted(); this.ready = true; this.challenge = undefined;
              settled = true; clearTimeout(timer); resolve();
            } else if (event.type === 'auth' && !this.ready && !this.challenge && /^[1-3]$/u.test(event.id)) {
              this.challenge = event.id;
              void authenticate(event.id).then((answer) => {
                if (this.closed || this.ready || this.challenge !== event.id) return;
                current(); this.signal.throwIfAborted(); this.challenge = undefined;
                broker.write(JSON.stringify({ type: 'answer', id: event.id, answer }) + '\n');
              }).catch(fail);
            } else if (event.type === 'output' && this.ready && typeof event.data === 'string' && this.active) {
              this.active.push(Buffer.from(event.data));
            } else { fail(); return; }
          } catch { fail(); return; }
        }
      });
    });
  }
  connectionGeneration(): number { return this.closed ? 2 : 1; }
  async prepareCommandProgram(_id: string, _source: string, current: () => void): Promise<string> {
    current(); this.assertReady(); return 'fixed-root-command-program';
  }
  async removeCommandProgram(): Promise<void> { /* Embedded program; session owns cleanup. */ }
  async shell(): Promise<ClientChannel> { throw new Error('Root sessions cannot become an unaudited interactive shell'); }
  async openPipe(): Promise<ClientChannel> {
    this.assertReady();
    if (this.active) throw new Error('Root command already active');
    const broker = this.broker!;
    let ended = false;
    const end = () => {
      if (ended) return; ended = true;
      if (this.active === channel) this.active = undefined;
      if (!this.closed) broker.write('{"type":"end"}\n');
    };
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
      if (ended) { callback(new Error('Root command ended')); return; }
      broker.write(JSON.stringify({ type: 'control', data: chunk.toString('utf8') }) + '\n', callback);
    }, final(callback) { end(); callback(); }, destroy(_error, callback) { end(); callback(); } });
    const channel = Object.assign(stream, { stderr: new PassThrough(), close: () => { end(); stream.destroy(); } }) as unknown as ClientChannel;
    this.active = channel;
    broker.write('{"type":"start"}\n');
    return channel;
  }
  private assertReady(): void {
    if (!this.ready || this.closed || this.signal.aborted || this.generation !== this.ssh.connectionGeneration(this.hostId)) throw new Error('Root session expired');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.challenge = undefined;
    this.signal.removeEventListener('abort', this.abort);
    this.active?.destroy(); this.broker?.end(); this.broker?.close();
    this.onClosed();
    if (this.program && this.generation === this.ssh.connectionGeneration(this.hostId)) {
      void this.ssh.removeCommandProgram(this.hostId, this.program).catch(() => {});
    }
  }
}
