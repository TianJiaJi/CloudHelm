import { StringDecoder } from 'node:string_decoder';
import { CommandNotStartedError, SUDO_SESSION_PROMPT, sudoSessionCommand,
  type CommandExecutionOptions, type ExecutionFailureFact, type NativeStartTarget, type RawTerminal } from '@cloudhelm/core';
import { BashAnalyzer } from './bash-analyzer.js';
import type { SshTransport } from './ssh-transport.js';

export type SessionTransport = Pick<SshTransport, 'connectionGeneration' | 'execFixed' | 'runNativeExec'>;

/** sudo session credential channel owned by the privileged runtime. The
 * password travels from here to the exec channel's stdin only; it never
 * appears in command text, argv, output, or logs. */
export interface SudoSessionChannel {
  /** Resolve the sudo password from the session's memory cache or a bound user
   * confirmation. Returns undefined when the user declined or the request
   * expired; the command is then never dispatched. */
  credential(context: { command: string }): Promise<string | undefined>;
  /** sudo rejected the injected password (or died unconfirmed while
   * challenging it); the runtime must drop its cache so the next dispatch
   * asks again instead of replaying a rejected secret. */
  rejected(): void;
}

/** Privileged session terminal. Each reviewed command is dispatched once over a
 * native exec channel with zero remote placement: sudo sessions rebuild the
 * reviewed command as `sudo -k -S` and inject the password through stdin, root
 * login sessions inherit identity from the transport and run the reviewed
 * command verbatim. Nothing is installed on the host and no reusable remote
 * state is created. */
export class NativeSessionTerminal implements RawTerminal {
  private readonly generation: number;
  private readonly analyzer = new BashAnalyzer();
  private closed = false;
  private busy = false;
  private abort?: AbortController;
  private data = (_text: string) => {};
  private failure = (_failure: ExecutionFailureFact) => {};
  private exited = (_code: number | undefined) => {};
  private closedListener = () => {};

  constructor(private readonly ssh: SessionTransport, private readonly hostId: string,
    private readonly sudo?: SudoSessionChannel) {
    this.generation = ssh.connectionGeneration(hostId);
  }

  onData(listener: (text: string) => void): void { this.data = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onClose(listener: () => void): void { this.closedListener = listener; }

  async execute(command: string, cwd: string, isAuthorized: () => boolean, options?: CommandExecutionOptions): Promise<void> {
    if (this.busy || this.closed) throw new Error('The session terminal is busy or closed');
    this.busy = true;
    try {
      const current = () => {
        if (this.closed || this.generation !== this.ssh.connectionGeneration(this.hostId) || !isAuthorized()) {
          throw new Error('Session command authorization expired');
        }
      };
      current();
      const analysis = await this.analyzer.analyze(command);
      if (analysis.hasError) throw new Error('Command parsing failed');
      current();
      const dispatch = this.sudo ? sudoSessionCommand(analysis) : command;
      if (!dispatch) throw new CommandNotStartedError('Session sudo form cannot be rebuilt for stdin injection; nothing sent');
      // Fixed read-only tool check before dispatch. No process.py, Python, or SFTP.
      const tools = await this.ssh.execFixed(this.hostId,
        'test -x /usr/bin/env && test -x /bin/sh && /usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c "exit 0"');
      current();
      if (tools.exitCode !== 0) {
        this.failure({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
        this.data('会话命令未发送：主机缺少 /usr/bin/env 或 /bin/sh。');
        this.exited(undefined);
        return;
      }
      let password: string | undefined;
      if (this.sudo) {
        password = await this.sudo.credential({ command });
        current();
        if (password === undefined || password === '' || /[\r\n\u0000]/u.test(password)) {
          this.sudo.rejected();
          this.failure({ failureKind: 'not-dispatched', effects: 'none', requiresUserAction: true,
            handoff: 'not-sent', businessStart: 'not-started',
            privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-unconfirmed',
              source: 'transport', businessCommand: 'not-started', recovery: 'user-action' } });
          this.data('sudo 会话密码未确认；业务命令未发送。需要用户明确继续。');
          this.exited(undefined);
          return;
        }
      }
      current();
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      // The transport binds the rebuilt sudo -k -S dispatch text; the claim
      // consumes the reviewed command and directory, so verify the dispatch
      // binding and rebind before consulting the gate.
      const claimStart = options?.claimStart;
      const claimHook: ((dispatched: NativeStartTarget) => boolean) | undefined = claimStart
        ? (dispatched) => dispatched.hostId === this.hostId && dispatched.command === dispatch && dispatched.cwd === cwd
          ? claimStart({ hostId: this.hostId, command, cwd }) : false
        : undefined;
      const emit = (decoder: StringDecoder, chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (text) this.data(text);
      };
      let authRejected = false;
      let stderrText = '';
      let stdinEnd: (() => void) | undefined;
      const controller = new AbortController();
      this.abort = controller;
      try {
        const outcome = await this.ssh.runNativeExec(this.hostId,
          { command: dispatch, cwd, envPath: '/usr/bin/env', shellPath: '/bin/sh' },
          () => { current(); return true; },
          { stdout: (chunk) => emit(stdout, chunk),
            stderr: (chunk) => {
              emit(stderr, chunk);
              if (!this.sudo) return;
              // The prompt is pure ASCII, so per-chunk decoding cannot split it.
              stderrText += chunk.toString('utf8');
              if (!authRejected && countOccurrences(stderrText, SUDO_SESSION_PROMPT) >= 2) {
                // sudo rejected the first injected password and is asking again.
                // End stdin so the retry read gets EOF instead of blocking; the
                // channel itself never sees a second secret.
                authRejected = true;
                stdinEnd?.();
              }
            },
            stdin: (write, end) => {
              stdinEnd = end;
              if (this.sudo && password !== undefined) write(Buffer.from(`${password}\n`, 'utf8'));
            },
            claimStart: claimHook },
          controller.signal);
        for (const decoder of [stdout, stderr]) { const tail = decoder.end(); if (tail) this.data(tail); }
        const suspectedAuthenticationFailure = !!this.sudo && (authRejected
          || /incorrect password attempt|no correct password|authentication failure/iu.test(stderrText));
        // Invalidate cached credentials defensively, but stderr may belong to
        // the payload: repetition of a prompt or diagnostic never proves no effects.
        if (suspectedAuthenticationFailure) this.sudo?.rejected();
        if (outcome.state === 'not-dispatched') this.failure({ failureKind: 'not-dispatched', effects: 'none', handoff: 'not-sent', businessStart: 'not-started' });
        else if (suspectedAuthenticationFailure && !(outcome.state === 'exited' && outcome.exitCode === 0)) {
          this.failure({ failureKind: 'authentication-failed', effects: 'possible',
            handoff: 'handed-off',
            privilege: { method: 'sudo', stage: 'authentication', code: 'authentication-rejected',
              source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' } });
          this.data('输出包含疑似 sudo 认证失败信息；不能据此证明业务未启动。已清除本地缓存，请先核验原操作，不自动重放。');
        }
        else if (outcome.state === 'exited' && outcome.exitCode === 0)
          // Exit 0 on the session channel means sudo (or the verbatim root form)
          // completed the reviewed business successfully.
          this.failure({ handoff: 'handed-off', businessStart: 'started' });
        else if (outcome.state === 'exited' || outcome.state === 'signaled') this.failure({ handoff: 'handed-off' });
        if (outcome.state === 'signaled') this.data(`远端会话命令收到 ${outcome.signal}；未观察到可确认的退出码。`);
        if (outcome.state === 'unknown') this.data('原生会话命令结果未知；请核验原操作，不要直接重放。');
        this.exited(outcome.state === 'exited' ? outcome.exitCode : undefined);
      } finally {
        password = undefined;
        this.abort = undefined;
      }
    } finally {
      this.busy = false;
    }
  }

  write(text: string): void {
    if (text === '\u0003') { this.abort?.abort(); return; }
  }

  resize(_cols: number, _rows: number): void { /* No PTY on the session channel. */ }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.closedListener();
  }
}

/** Count non-overlapping occurrences of the marker inside the accumulated text. */
function countOccurrences(text: string, marker: string): number {
  let count = 0;
  for (let index = text.indexOf(marker); index >= 0; index = text.indexOf(marker, index + marker.length)) count++;
  return count;
}
