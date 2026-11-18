import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import { renderNativeExecCommand } from './native-exec-command.js';

export type NativePtyOutcome =
  | { state: 'not-dispatched'; reason: 'authorization-expired' }
  | { state: 'exited'; exitCode: number; markerSeen: boolean; sudoMissing: boolean }
  | { state: 'signaled'; signal: string; coreDumped: boolean }
  | { state: 'unknown'; reason: 'allocation' | 'timeout' | 'aborted' | 'channel-error' | 'missing-exit' | 'authorization-expired' | 'output-limit' };

export interface NativePtyHandle {
  /** Resolves once; an unknown outcome may still mean the command is running. */
  result: Promise<NativePtyOutcome>;
  /** Resolve the open password window; answer === null cancels without writing. */
  answer(id: string, answer: string | null): boolean;
  /** Raw PTY input, never recorded; confirmations and \u0003 only. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_SUPPRESSED_BYTES = 4096;
const MAX_INJECTIONS = 3;
/** C-locale sudo retry notice; the LC_ALL=C wrapper guarantees this spelling. */
const SUDO_FAILURE = 'Sorry, try again.';
/** Shell-reported sudo absence (dash, bash-as-sh, BusyBox), never sudo's own child
 * diagnostics; the busybox multi-call stub also means sudo is unavailable. */
const SUDO_MISSING = /(?:^|[\r\n])(?:(?!sudo:)[^\r\n]{0,128}sudo: (?:command )?not found|sudo: applet not found)/u;

/** One sudo command on a client-owned PTY. The password is injected only after the
 * unguessable per-dispatch marker appears and only into a suppressed window, so it
 * never reaches command output, logs, or the model context. Channel closure or
 * abort is never proof of process exit: an unknown outcome may still be running. */
export function openNativeSshPty(client: Pick<Client, 'exec'> | undefined, input: {
  command: string; cwd: string; envPath: string; shellPath: string; nonce: string; cols: number; rows: number;
}, current: () => boolean, hooks: {
  data(text: string): void; authentication(event: { id: string; open: boolean }): void;
}, signal?: AbortSignal, startupTimeoutMs = 15_000): NativePtyHandle {
  const rendered = renderNativeExecCommand(input);
  if (!/^[a-f0-9]{32}$/u.test(input.nonce)) throw new Error('Native PTY requires a client-generated marker nonce');
  const scanTarget = `cloudhelm:${input.nonce}`;
  // The marker never wraps: sudo's prompt stays below 80 columns on every width.
  const cols = Math.max(80, Math.min(1000, Math.trunc(input.cols)));
  const rows = Math.max(1, Math.min(1000, Math.trunc(input.rows)));
  const dead = { result: Promise.resolve({ state: 'not-dispatched', reason: 'authorization-expired' } as const),
    answer: () => false, write: () => {}, resize: () => {} };
  if (!client || signal?.aborted || !current()) return dead;
  return new LiveNativePtySession(client, rendered, scanTarget, cols, rows, current, hooks, signal, startupTimeoutMs).handle;
}

/** Separate class so the dead handle above stays allocation-free. */
class LiveNativePtySession {
  private channel?: ClientChannel;
  private settled = false;
  private requested = false;
  private outputBytes = 0;
  private exit: NativePtyOutcome | undefined;
  private windowOpen = false;
  private challengeId = '';
  private injections = 0;
  private failureSeen = false;
  private swallowedFailure = false;
  private suppressing = false;
  private awaitingInjection = false;
  private suppressedBytes = 0;
  private markerSeenOnce = false;
  private sudoMissing = false;
  private carry = Buffer.alloc(0);
  private featureTail = '';
  private readonly decoder = new StringDecoder('utf8');
  private resolveResult!: (outcome: NativePtyOutcome) => void;
  private readonly resultPromise = new Promise<NativePtyOutcome>((resolve) => { this.resolveResult = resolve; });
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly handle: NativePtyHandle = {
    result: this.resultPromise,
    answer: (id: string, answer: string | null): boolean => this.answer(id, answer),
    write: (data: string): void => this.write(data),
    resize: (cols: number, rows: number): void => this.resize(cols, rows),
  };

  constructor(private readonly client: Pick<Client, 'exec'>, private readonly rendered: string,
    private readonly scanTarget: string, private readonly cols: number, private readonly rows: number,
    private readonly current: () => boolean, private readonly hooks: {
      data(text: string): void; authentication(event: { id: string; open: boolean }): void;
    }, signal: AbortSignal | undefined, startupTimeoutMs: number) {
    this.timer = setTimeout(() => this.finish({ state: 'unknown', reason: 'timeout' }), startupTimeoutMs);
    this.timer.unref?.();
    signal?.addEventListener('abort', () => this.finish(this.requested
      ? { state: 'unknown', reason: 'aborted' } : { state: 'not-dispatched', reason: 'authorization-expired' }), { once: true });
    try {
      this.requested = true;
      this.client.exec(this.rendered, { pty: { term: 'dumb', cols: this.cols, rows: this.rows, modes: { ECHO: 0 } } },
        (error, stream) => {
          if (this.settled) {
            stream?.on('error', () => {});
            try { stream?.close(); } catch { /* Already unknown. */ }
            return;
          }
          this.channel = stream;
          if (error || !stream) { this.finish({ state: 'unknown', reason: 'allocation' }); return; }
          clearTimeout(this.timer);
          if (!this.current()) { this.finish({ state: 'unknown', reason: 'authorization-expired' }); return; }
          stream.on('data', (data: Buffer) => this.processChunk(data));
          stream.on('error', () => this.finish({ state: 'unknown', reason: 'channel-error' }));
          stream.on('exit', (code: number | null, name?: string, coreDumped?: boolean) => {
            this.exit = Number.isInteger(code) && code !== null && code >= 0 && code <= 255
              ? { state: 'exited', exitCode: code, markerSeen: this.markerSeenOnce, sudoMissing: this.sudoMissing }
              : typeof name === 'string' && /^[A-Z0-9]{1,24}$/u.test(name)
                ? { state: 'signaled', signal: name, coreDumped: coreDumped === true }
                : undefined;
          });
          stream.on('close', () => this.finish(!this.current() ? { state: 'unknown', reason: 'authorization-expired' }
            : this.exit ?? { state: 'unknown', reason: 'missing-exit' }));
        });
    } catch { this.finish({ state: 'unknown', reason: 'allocation' }); }
  }

  private answer(id: string, answer: string | null): boolean {
    if (this.settled || !this.windowOpen || id !== this.challengeId) return false;
    if (answer !== null && (answer.length > 4095 || /[\r\n\u0000]/u.test(answer))) return false;
    const closed = this.challengeId;
    this.windowOpen = false;
    this.challengeId = '';
    if (answer === null) {
      // Cancel writes nothing and closes the channel: the outcome stays unknown.
      this.notifyClosed(closed);
      this.finish({ state: 'unknown', reason: 'aborted' });
      return true;
    }
    this.injections++;
    this.failureSeen = false;
    this.awaitingInjection = false;
    this.notifyClosed(closed);
    this.write(`${answer}\n`);
    return true;
  }

  private notifyClosed(id: string): void {
    try { this.hooks.authentication({ id, open: false }); } catch { /* The command outcome still stands. */ }
  }

  private write(data: string): void {
    if (this.settled || !this.channel || this.channel.destroyed) return;
    try { this.channel.write(Buffer.from(data, 'utf8')); } catch { /* Channel errors surface via the error handler. */ }
  }

  private resize(cols: number, rows: number): void {
    if (this.settled || !this.channel) return;
    try {
      this.channel.setWindow(Math.max(1, Math.min(1000, Math.trunc(rows))),
        Math.max(80, Math.min(1000, Math.trunc(cols))), 0, 0);
    } catch { /* A failed resize never fails the command. */ }
  }

  private emit(bytes: Buffer): void {
    if (!bytes.length) return;
    try {
      // A failure line that reached output already told the user; do not repeat it.
      if (this.swallowedFailure && bytes.includes(SUDO_FAILURE)) this.swallowedFailure = false;
      const text = this.decoder.write(bytes);
      if (text) this.hooks.data(text);
    } catch { this.finish({ state: 'unknown', reason: 'channel-error' }); }
  }

  private processChunk(chunk: Buffer): void {
    if (this.settled) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > MAX_OUTPUT_BYTES) { this.finish({ state: 'unknown', reason: 'output-limit' }); return; }
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    const text = buf.toString('latin1');
    // Feature scans run on the raw stream, before suppression: a swallowed retry
    // notice must still re-arm the window and sudo-missing evidence must survive
    // even when the prompt region is suppressed.
    const features = this.featureTail + text;
    if (!this.failureSeen && features.includes(SUDO_FAILURE)) {
      this.failureSeen = true;
      if (this.suppressing) this.swallowedFailure = true;
    }
    if (!this.sudoMissing && SUDO_MISSING.test(features)) this.sudoMissing = true;
    this.featureTail = features.slice(-256);
    // The marker search runs over the raw stream, even inside a suppressed region:
    // sudo can re-prompt without emitting the post-read newline first.
    let pos = 0;
    while (pos < text.length && !this.settled) {
      const marker = text.indexOf(this.scanTarget, pos);
      let start = marker;
      if (start >= 0 && start > pos && text[start - 1] === '\r') start--;
      const spanEnd = marker < 0 ? text.length : start;
      // Consume the suppressed prefix of this span; `resumed` is where output
      // becomes flow-through again.
      const resumed = this.consumeSuppressed(text, pos, spanEnd);
      if (marker < 0) {
        if (resumed < spanEnd || !this.suppressing) {
          // Flow-through tail: hold back only a suffix that could still grow into
          // the marker, so an apt confirmation prompt is never stalled.
          const lookback = this.scanTarget.length - 1;
          const hold = this.markerHoldback(text.slice(Math.max(resumed, spanEnd - lookback)));
          this.emit(buf.subarray(resumed, spanEnd - hold));
          this.carry = hold > 0 ? Buffer.from(buf.subarray(spanEnd - hold)) : Buffer.alloc(0);
        } else {
          // The whole span was suppressed: re-queue its tail so a marker
          // straddling the chunk boundary is still found in the next chunk.
          const tail = Math.min(spanEnd - pos, this.scanTarget.length - 1);
          this.carry = tail > 0 ? Buffer.from(buf.subarray(spanEnd - tail)) : Buffer.alloc(0);
        }
        break;
      }
      if (resumed < start) this.emit(buf.subarray(resumed, start));
      // The marker bytes belong to the suppressed prompt region either way: the
      // window-open path consumes them silently, the gate-fail path emits them.
      pos = marker + this.scanTarget.length;
      if (!this.openWindowAtMarker()) {
        // A marker that cannot open a window is not secret: emit it verbatim.
        this.emit(buf.subarray(start, marker + this.scanTarget.length));
      }
    }
  }

  /** Consume the suppressed prefix of one marker-free span; returns the position
   * where flow-through output resumes (only suppressed bytes are consumed). */
  private consumeSuppressed(text: string, from: number, to: number): number {
    let cursor = from;
    while (cursor < to && this.suppressing) {
      // The suppressed region ends at the first newline after the injection or at
      // the byte cap; while the window still awaits its answer, newlines do not end it.
      const newline = text.indexOf('\n', cursor);
      const end = newline < 0 || newline >= to ? to : newline + 1;
      const take = Math.min(end - cursor, MAX_SUPPRESSED_BYTES - this.suppressedBytes);
      cursor += take;
      this.suppressedBytes += take;
      if (this.suppressedBytes >= MAX_SUPPRESSED_BYTES) this.suppressing = false;
      else if (newline >= 0 && newline < to && !this.awaitingInjection) this.suppressing = false;
    }
    return cursor;
  }

  /** Longest suffix of text that could still grow into the marker. */
  private markerHoldback(text: string): number {
    const limit = Math.min(text.length, this.scanTarget.length - 1);
    for (let length = limit; length > 0; length--) {
      if (text.endsWith(this.scanTarget.slice(0, length))) return length;
    }
    return 0;
  }

  private openWindowAtMarker(): boolean {
    this.markerSeenOnce = true;
    if (this.windowOpen) {
      // A duplicate echo while the window is already open never mints a second
      // injectable id; it only re-arms suppression around the same prompt.
      this.suppressing = true;
      this.awaitingInjection = true;
      this.suppressedBytes = 0;
      return true;
    }
    if (this.injections >= MAX_INJECTIONS) return false;
    // A marker without a real failed attempt cannot re-open the window: a payload
    // echoing the command line must never turn the PTY into a password oracle.
    if (this.injections > 0 && !this.failureSeen) return false;
    if (this.swallowedFailure) {
      this.swallowedFailure = false;
      try { this.hooks.data('\r\nsudo：密码验证未通过，请重试。\r\n'); } catch { /* The prompt still opens. */ }
    }
    this.windowOpen = true;
    this.challengeId = randomUUID().replaceAll('-', '');
    this.failureSeen = false;
    this.suppressing = true;
    this.awaitingInjection = true;
    this.suppressedBytes = 0;
    try { this.hooks.authentication({ id: this.challengeId, open: true }); }
    catch { this.finish({ state: 'unknown', reason: 'channel-error' }); }
    return true;
  }

  private finish(outcome: NativePtyOutcome): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    if (this.windowOpen) {
      const id = this.challengeId;
      this.windowOpen = false;
      this.challengeId = '';
      this.notifyClosed(id);
    }
    try {
      // A holdback carry is unemitted output and must not be lost; a straddle
      // carry re-queues already-suppressed bytes and must stay suppressed.
      if (!this.suppressing && this.carry.length) {
        const held = this.carry;
        this.carry = Buffer.alloc(0);
        const text = this.decoder.write(held);
        if (text) this.hooks.data(text);
      }
      const rest = this.decoder.end();
      if (rest) this.hooks.data(rest);
    } catch { /* Listener failure must not mask the outcome. */ }
    try { this.channel?.close(); } catch { /* No assumption that the remote process stopped. */ }
    this.resolveResult(outcome);
  }
}
