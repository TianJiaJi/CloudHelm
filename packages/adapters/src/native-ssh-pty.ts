import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import { renderNativeExecCommand } from './native-exec-command.js';

export type NativePtyOutcome =
  | { state: 'not-dispatched'; reason: 'authorization-expired' }
  // Diagnostic flags are inferred from mixed PTY text, not trusted startup evidence.
  | { state: 'exited'; exitCode: number; markerSeen: boolean; sudoMissing: boolean;
      suAuthenticationFailed?: boolean; suMissing?: boolean; suUserMissing?: boolean; sudoDenied?: boolean }
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
/** C-locale sudoers diagnostic. Business output can imitate this text; even a
 * prompt marker plus a nonzero exit cannot prove that the payload never started. */
const SUDO_DENIED = /(?:^|[\r\n])(?:sudo:[^\r\n]{0,256}(?:not allowed to execute|not in the sudoers|may not run sudo)|[a-z_][a-z0-9_.-]{0,63}[$]? is not in the sudoers file\b|Sorry,\s*user [^\r\n]{1,128} (?:is not allowed to execute|may not run sudo)\b)/iu;
/** pam's su password prompt; su reads the answer on the same line, no newline. */
const SU_PROMPT = 'Password:';
/** C-locale pam su failure notice; it follows the prompt without a line break
 * and su exits instead of re-prompting. */
const SU_FAILURE = /su: Authentication failure/u;
/** Shell-reported su absence, mirroring the sudo diagnostic pattern; the shell
 * diagnostic directly follows the printf marker with no line break. */
const SU_MISSING = /(?:^|[\r\n])(?:(?!su:)[^\r\n]{0,128}su: (?:command )?not found|su: applet not found)/u;
/** su rejects an unknown target account before prompting; the notice directly
 * follows the printf marker with no line break. */
const SU_USER_MISSING = /(?:^|[\r\n])su: user [^\r\n]{0,128} does not exist/u;
export type PtyWindow = 'sudo-marker' | 'su-window';
type SuState = 'idle' | 'armed' | 'open' | 'injected' | 'cancelled' | 'disarmed';

/** One sudo command on a client-owned PTY. The password is injected only after the
 * unguessable per-dispatch marker appears and only into a suppressed window, so it
 * never reaches command output, logs, or the model context. Channel closure or
 * abort is never proof of process exit: an unknown outcome may still be running. */
export function openNativeSshPty(client: Pick<Client, 'exec'> | undefined, input: {
  command: string; cwd: string; envPath: string; shellPath: string; nonce: string; cols: number; rows: number;
  window?: PtyWindow;
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
  return new LiveNativePtySession(client, rendered, scanTarget, input.window ?? 'sudo-marker', cols, rows, current, hooks, signal, startupTimeoutMs).handle;
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
  private sudoDenied = false;
  private suAuthenticationFailed = false;
  private suMissing = false;
  private suUserMissing = false;
  private suState: SuState = 'idle';
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
    private readonly scanTarget: string, private readonly mode: PtyWindow,
    private readonly cols: number, private readonly rows: number,
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
              ? this.mode === 'su-window'
                ? { state: 'exited', exitCode: code, markerSeen: this.markerSeenOnce, sudoMissing: false,
                  ...(this.suAuthenticationFailed ? { suAuthenticationFailed: true } : {}),
                  ...(this.suMissing ? { suMissing: true } : {}),
                  ...(this.suUserMissing ? { suUserMissing: true } : {}) }
                : { state: 'exited', exitCode: code, markerSeen: this.markerSeenOnce, sudoMissing: this.sudoMissing,
                  ...(this.sudoDenied ? { sudoDenied: true } : {}) }
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
    if (this.mode === 'su-window') {
      this.windowOpen = false;
      this.challengeId = '';
      if (answer === null) {
        // Cancel writes nothing and closes the channel: the outcome stays unknown.
        this.notifyClosed(closed);
        this.finish({ state: 'unknown', reason: 'aborted' });
        return true;
      }
      // su never re-prompts, so exactly one injection is structurally guaranteed.
      this.notifyClosed(closed);
      this.suState = 'injected';
      this.write(`${answer}\n`);
      return true;
    }
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
    if (this.mode === 'su-window') {
      // Feature scans run on the raw stream so evidence survives regardless of
      // what the span processor consumes. su's diagnostics directly follow the
      // printf marker without a line break, so evidence starts at the marker,
      // never at an arbitrary line boundary.
      const features = this.featureTail + text;
      const markerAt = this.markerSeenOnce ? 0 : features.indexOf(this.scanTarget);
      const evidence = markerAt >= 0
        ? features.slice(markerAt + (this.markerSeenOnce ? 0 : this.scanTarget.length)) : '';
      if (!this.suAuthenticationFailed && SU_FAILURE.test(evidence)) this.suAuthenticationFailed = true;
      if (!this.suMissing && SU_MISSING.test(evidence)) this.suMissing = true;
      if (!this.suUserMissing && SU_USER_MISSING.test(evidence)) this.suUserMissing = true;
      this.featureTail = (markerAt >= 0 ? evidence : '').slice(-256);
      this.processSuSpan(buf, text);
      return;
    }
    // Feature scans run on the raw stream, before suppression: a swallowed retry
    // notice must still re-arm the window and sudo-missing evidence must survive
    // even when the prompt region is suppressed.
    const features = this.featureTail + text;
    if (!this.failureSeen && features.includes(SUDO_FAILURE)) {
      this.failureSeen = true;
      if (this.suppressing) this.swallowedFailure = true;
    }
    if (!this.sudoMissing && SUDO_MISSING.test(features)) this.sudoMissing = true;
    if (!this.sudoDenied && SUDO_DENIED.test(features)) this.sudoDenied = true;
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

  /** su-window scan: the printf marker arms, only su's own password prompt may
   * then open the window, and one answer is the only injection. Anything else
   * between marker and prompt disarms permanently; passwordless su and payload
   * echoes therefore finish as ordinary flow-through output. */
  private processSuSpan(buf: Buffer, text: string): void {
    let pos = 0;
    while (pos < text.length && !this.settled) {
      if (this.suState === 'injected' || this.suState === 'cancelled' || this.suState === 'disarmed') {
        // Post-decision output is ordinary flow-through; su diagnostics such as
        // the failure notice are evidence, never credentials.
        this.emit(buf.subarray(pos));
        return;
      }
      if (this.suState === 'open') {
        // su blocks on the password read, so it cannot emit more prompt bytes;
        // a prompt tail fragment is inert whitespace. Anything else means the
        // window no longer has a trustworthy recipient: close it without writing.
        const rest = text.slice(pos);
        if (/^[\t ]{1,4}$/u.test(rest)) return;
        this.cancelSuWindow();
        continue;
      }
      if (this.suState === 'idle') {
        const marker = text.indexOf(this.scanTarget, pos);
        if (marker < 0) {
          // Hold back only a suffix that could still grow into the marker.
          const lookback = this.scanTarget.length - 1;
          const hold = this.markerHoldback(text.slice(Math.max(pos, text.length - lookback)));
          this.emit(buf.subarray(pos, text.length - hold));
          this.carry = hold > 0 ? Buffer.from(buf.subarray(text.length - hold)) : Buffer.alloc(0);
          return;
        }
        this.emit(buf.subarray(pos, marker));
        this.markerSeenOnce = true;
        this.suState = 'armed';
        pos = marker + this.scanTarget.length;
        continue;
      }
      // armed: between marker and su's prompt only line breaks may appear.
      const rest = text.slice(pos);
      const lineBreaks = /^[\r\n]*/u.exec(rest)![0].length;
      if (lineBreaks > 0) { this.emit(buf.subarray(pos, pos + lineBreaks)); pos += lineBreaks; continue; }
      if (rest.startsWith(SU_PROMPT)) {
        pos += SU_PROMPT.length + (rest[SU_PROMPT.length] === ' ' ? 1 : 0);
        this.openSuWindow();
        continue;
      }
      const partial = this.promptHoldback(rest);
      if (partial === rest.length) { this.carry = Buffer.from(buf.subarray(pos)); return; }
      // First non-prompt byte: passwordless su or an echo. Never open a window
      // again for this dispatch; everything from here is flow-through.
      this.suState = 'disarmed';
    }
  }

  private openSuWindow(): void {
    this.windowOpen = true;
    this.challengeId = randomUUID().replaceAll('-', '');
    this.suState = 'open';
    try { this.hooks.authentication({ id: this.challengeId, open: true }); }
    catch { this.finish({ state: 'unknown', reason: 'channel-error' }); }
  }

  /** Unexpected output while the window is open: close without writing. su stays
   * blocked on its password read until the user stops the operation. */
  private cancelSuWindow(): void {
    const id = this.challengeId;
    this.windowOpen = false;
    this.challengeId = '';
    this.suState = 'cancelled';
    if (id) this.notifyClosed(id);
    try { this.hooks.data('\r\nsu：密码窗口期间出现异常输出，密码未写入；本次操作已失效，请停止并核验。\r\n'); }
    catch { /* The hang still surfaces via the outcome. */ }
  }

  /** Longest suffix of text that could still grow into the su password prompt. */
  private promptHoldback(text: string): number {
    const limit = Math.min(text.length, SU_PROMPT.length);
    for (let length = limit; length > 0; length--) {
      if (text.endsWith(SU_PROMPT.slice(0, length))) return length;
    }
    return 0;
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
