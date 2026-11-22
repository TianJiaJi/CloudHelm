import { ShellMarkerParser, type ShellCommandEvent } from './shell-integration.js';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { CommandNotStartedError, nativeBackgroundEligible, nativeCommandEligible, nativePtySudoEligible, nativePtySuEligible, sudoMarkerPrompt, sudoPtyCommand,
  type CommandAnalysis, type OperationResult, type ProcessStartedEvent, type RawTerminal } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';
import { BashAnalyzer } from './bash-analyzer.js';
import type { SshTransport } from './ssh-transport.js';
export type CommandTransport = Pick<SshTransport, 'connectionGeneration' | 'shell'> & Partial<Pick<SshTransport, 'integratedShell' | 'runNativeExec' | 'runNativePty' | 'execFixed'>>;
import type { NativePtyHandle, NativePtyOutcome } from './native-ssh-pty.js';
import { NATIVE_BACKGROUND_PROC_GONE, parseNativeBackgroundExit, parseNativeBackgroundPid, parseNativeBackgroundStat,
  renderNativeBackgroundLaunch, renderNativeBackgroundLogPath, renderNativeBackgroundStatCheck, renderNativeBackgroundStop,
  renderNativeBackgroundWatcher } from './native-background.js';
import type { NativeExecOutcome } from './native-ssh-exec.js';

/** Commands are process arguments; PTY input and sudo credentials have distinct channels. */
export class SshCommandTerminal implements RawTerminal {
  private human?: ClientChannel;
  private humanOpening?: Promise<ClientChannel>;
  private humanOwned = false;
  private closed = false;
  private busy = false;
  private lineStart = true;
  private cols = 100;
  private rows = 30;
  private command = (_event: ShellCommandEvent) => {};
  onCommand(listener: (event: ShellCommandEvent) => void): void { this.command = listener; }
  private data = (_text: string) => {};
  private display = (_text: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege' | 'requiresUserAction'>) => {};
  private exited = (_code: number | undefined) => {};
  private closedListener = () => {};
  private authentication = (_challenge: { id: string; prompt?: string }) => {};
  private started = (_event: ProcessStartedEvent) => {};
  private startupTimer?: ReturnType<typeof setTimeout>;
  private nativeAbort?: AbortController;
  private ptySession?: NativePtyHandle;
  private ptyAbort?: AbortController;
  /** Native-background launch observation; the pid is also the signalable process group. */
  private bgWatch?: { pid: number; logPath: string; processStartTime: number; current: () => void; abort: AbortController };
  private readonly ptyChallenges = new Set<string>();
  private readonly generation: number;
  private readonly analyzer = new BashAnalyzer();

  constructor(private readonly ssh: CommandTransport, private readonly hostId: string) {
    this.generation = ssh.connectionGeneration(hostId);
  }

  onData(listener: (text: string) => void): void { this.data = listener; }
  onDisplay(listener: (text: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onProcessStarted(listener: (event: ProcessStartedEvent) => void): void { this.started = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onClose(listener: () => void): void { this.closedListener = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.authentication = listener; }

  async execute(command: string, cwd: string, isAuthorized: () => boolean, options?: { sudoAuthorization?: boolean; executionChannel?: 'native-exec' | 'native-pty' | 'native-background' }): Promise<void> {
    if (this.busy || this.human || this.humanOpening) throw new Error('The command terminal is busy');
    this.busy = true;
    const deadline = new Promise<never>((_resolve, reject) => this.armStartup(reject));
    try { await Promise.race([this.executeCommand(command, cwd, isAuthorized, options), deadline]); }
    catch (error) {
      this.busy = false; this.clearStartup();
      if (this.humanOwned && !this.closed) void this.openHuman().catch(() => this.close());
      throw error;
    }
  }

  private async executeCommand(command: string, cwd: string, isAuthorized: () => boolean,
    options?: { sudoAuthorization?: boolean; executionChannel?: 'native-exec' | 'native-pty' | 'native-background' }): Promise<void> {
    const current = () => {
      if (this.closed || this.generation !== this.ssh.connectionGeneration(this.hostId) || !isAuthorized()) {
        throw new Error('Command authorization expired');
      }
    };
    current();
    const analysis = await this.analyzer.analyze(command);
    if (analysis.hasError) throw new Error('Command parsing failed');
    if (options?.executionChannel === 'native-exec') {
      if (!nativeCommandEligible({ id: '', kind: 'command', command, scope: { taskId: '', hostId: this.hostId,
        cwd, runAs: '', terminalId: '', terminalGeneration: 0, policyRevision: 0,
        allowedWorkingRoots: [], protectedPaths: [], goal: '' } }, analysis) || options.sudoAuthorization)
        throw new CommandNotStartedError('Native exec review no longer matches command; nothing sent');
      await this.executeNative(command, cwd, current);
      return;
    }
    if (options?.executionChannel === 'native-pty') {
      const scope = { taskId: '', hostId: this.hostId,
        cwd, runAs: '', terminalId: '', terminalGeneration: 0, policyRevision: 0,
        allowedWorkingRoots: [], protectedPaths: [], goal: '' };
      const sudo = nativePtySudoEligible({ id: '', kind: 'command', command, scope }, analysis);
      // sudoAuthorization is terminal-manager's attestation of privilege=root: only
      // the backend-built su wrap carries it, so an agent-supplied su never passes.
      const su = !sudo && options.sudoAuthorization === true
        && nativePtySuEligible({ id: '', kind: 'command', command, privilege: 'root', scope }, analysis);
      if (!sudo && !su) throw new CommandNotStartedError('Native PTY review no longer matches command; nothing sent');
      await this.executeNativePty(sudo ? 'sudo' : 'su', command, cwd, current, analysis);
      return;
    }
    if (options?.executionChannel === 'native-background') {
      const scope = { taskId: '', hostId: this.hostId,
        cwd, runAs: '', terminalId: '', terminalGeneration: 0, policyRevision: 0,
        allowedWorkingRoots: [], protectedPaths: [], goal: '' };
      if (!nativeBackgroundEligible({ id: '', kind: 'command', command, executionMode: 'background', scope }, analysis)
        || options.sudoAuthorization)
        throw new CommandNotStartedError('Native background review no longer matches command; nothing sent');
      await this.executeNativeBackground(command, cwd, current);
      return;
    }
    // The legacy remote Python driver is gone; a channel-less form never
    // dispatches from this terminal. Preflight blocks such forms with
    // alternatives before review; this is the dispatch-boundary backstop.
    throw new CommandNotStartedError('This command form has no native execution channel; nothing sent');
  }

  private async executeNative(command: string, cwd: string, current: () => void): Promise<void> {
    if (!this.ssh.execFixed || !this.ssh.runNativeExec) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.exited(undefined); this.busy = false; return;
    }
    current();
    // Fixed read-only tool check before dispatch. No process.py, Python, or SFTP.
    const tools = await this.ssh.execFixed(this.hostId,
      'test -x /usr/bin/env && test -x /bin/sh && /usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c "exit 0"');
    if (tools.exitCode !== 0) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.data('原生 SSH 命令未发送：主机缺少 /usr/bin/env 或 /bin/sh。');
      this.exited(undefined); this.busy = false; return;
    }
    current(); this.clearStartup();
    const controller = new AbortController(); this.nativeAbort = controller;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const emit = (decoder: StringDecoder, chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (text) { this.lineStart = text.endsWith('\n'); this.data(text); }
    };
    try {
      const outcome = await this.ssh.runNativeExec(this.hostId,
        { command, cwd, envPath: '/usr/bin/env', shellPath: '/bin/sh' },
        () => { current(); return true; },
        { stdout: (data) => emit(stdout, data), stderr: (data) => emit(stderr, data) }, controller.signal);
      for (const decoder of [stdout, stderr]) { const tail = decoder.end(); if (tail) this.data(tail); }
      if (outcome.state === 'not-dispatched') this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      if (outcome.state === 'signaled') this.data(`远端命令收到 ${outcome.signal}；未观察到可确认的退出码。`);
      if (outcome.state === 'unknown') this.data('原生 SSH 命令结果未知；请核验原操作，不要直接重放。');
      this.exited(outcome.state === 'exited' ? outcome.exitCode : undefined);
    } finally {
      this.nativeAbort = undefined; this.busy = false;
      if (this.humanOwned && !this.closed) void this.openHuman().catch(() => this.close());
    }
  }

  /** sudo/su on the credential-bound native PTY: the password reaches only the
   * client-owned marker window, never command text, output, or logs. */
  private async executeNativePty(subform: 'sudo' | 'su', command: string, cwd: string, current: () => void, analysis: CommandAnalysis): Promise<void> {
    if (!this.ssh.runNativePty) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.exited(undefined); this.busy = false; return;
    }
    current();
    const nonce = randomBytes(16).toString('hex');
    // The su wrap is dispatched verbatim as reviewed; only the one-time marker
    // prefix is added at dispatch, mirroring sudo's -k -p rebuild.
    const dispatch = subform === 'sudo'
      ? sudoPtyCommand(analysis, sudoMarkerPrompt(nonce))
      : `printf '%s' 'cloudhelm:${nonce}'; ${command}`;
    if (!dispatch) throw new CommandNotStartedError('Native PTY command cannot be rebuilt for this sudo form; nothing sent');
    current(); this.clearStartup();
    const controller = new AbortController(); this.ptyAbort = controller;
    const session = this.ssh.runNativePty(this.hostId,
      { command: dispatch, cwd: subform === 'sudo' ? cwd : '/', envPath: '/usr/bin/env', shellPath: '/bin/sh', nonce, cols: this.cols, rows: this.rows,
        window: subform === 'sudo' ? 'sudo-marker' : 'su-window' },
      () => { current(); return true; },
      { data: (text: string) => { if (text) { this.lineStart = text.endsWith('\n'); this.data(text); } },
        authentication: (event: { id: string; open: boolean }) => {
          if (!/^[a-f0-9]{32}$/u.test(event.id)) return;
          if (event.open) { this.ptyChallenges.add(event.id); this.authentication({ id: event.id, prompt: subform === 'sudo' ? 'sudo 身份验证' : 'su 身份验证' }); }
          else { this.ptyChallenges.delete(event.id); this.authentication({ id: event.id }); }
        } },
      controller.signal);
    this.ptySession = session;
    try {
      const outcome: NativePtyOutcome = await session.result;
      if (outcome.state === 'not-dispatched') this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      if (outcome.state === 'exited' && outcome.exitCode !== 0) {
        // All diagnostic flags below come from a mixed authentication/business
        // stream. Neither a prompt marker nor exit 1/125/127 establishes that
        // the payload never ran (including NOPASSWD commands without a marker).
        // Keep useful diagnostics, but never clear effects or authorize su from them.
        const unavailable = subform === 'sudo' ? outcome.sudoMissing : outcome.suMissing || outcome.suUserMissing;
        const denied = subform === 'sudo' ? outcome.sudoDenied : outcome.suAuthenticationFailed;
        if (unavailable || denied) this.failure({
          failureKind: unavailable ? 'unsupported' : 'authentication-failed', effects: 'possible',
          privilege: { method: subform,
            stage: unavailable ? 'preparation' : subform === 'sudo' ? 'authorization' : 'authentication',
            code: unavailable ? subform === 'sudo' ? 'sudo-unavailable' : 'unsupported'
              : subform === 'sudo' ? 'authorization-denied' : 'authentication-rejected',
            source: 'output-inference', businessCommand: 'unknown', recovery: 'verify' }
        });
      }
      if (outcome.state === 'signaled') this.data(`远端命令收到 ${outcome.signal}；未观察到可确认的退出码。`);
      if (outcome.state === 'unknown') this.data('原生 SSH 命令结果未知；请核验原操作，不要直接重放。');
      this.exited(outcome.state === 'exited' ? outcome.exitCode : undefined);
    } finally {
      this.ptySession = undefined; this.ptyAbort = undefined;
      for (const id of this.ptyChallenges) this.authentication({ id });
      this.ptyChallenges.clear();
      this.busy = false;
      if (this.humanOwned && !this.closed) void this.openHuman().catch(() => this.close());
    }
  }

  /** Detached native background launch. The reviewed command is embedded once into
   * a backend-rendered setsid body; the returned pid is the process group the
   * reviewed stop signals. Observation continues in a detached watcher channel;
   * this method returns right after the trusted start observation so the startup
   * bound cannot expire while the business runs. */
  private async executeNativeBackground(command: string, cwd: string, current: () => void): Promise<void> {
    if (!this.ssh.execFixed || !this.ssh.runNativeExec) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.exited(undefined); this.busy = false; return;
    }
    current();
    const tools = await this.ssh.execFixed(this.hostId,
      'test -x /usr/bin/env && test -x /bin/sh && /usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c "exit 0"');
    if (tools.exitCode !== 0) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.data('原生后台命令未发送：主机缺少 /usr/bin/env 或 /bin/sh。');
      this.exited(undefined); this.busy = false; return;
    }
    let launch: string, logPath: string;
    try { logPath = renderNativeBackgroundLogPath(); launch = renderNativeBackgroundLaunch({ command, logPath }); }
    catch (error) {
      throw new CommandNotStartedError(`后台命令未渲染或超出长度限制；未发送。${error instanceof Error ? error.message : ''}`);
    }
    current();
    const dispatched = await this.runBackgroundCommand(launch, cwd, current);
    if (dispatched.outcome.state === 'not-dispatched') {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.exited(undefined); this.busy = false; return;
    }
    if (dispatched.outcome.state !== 'exited') {
      this.data('原生后台启动结果未知；请核验原操作，不要直接重放。');
      this.exited(undefined); this.busy = false; return;
    }
    if (dispatched.outcome.exitCode !== 0) {
      this.data(`原生后台命令未启动（exit ${dispatched.outcome.exitCode}）；业务命令未发送。`);
      this.exited(dispatched.outcome.exitCode); this.busy = false; return;
    }
    const pid = parseNativeBackgroundPid(dispatched.output);
    if (pid === undefined) {
      this.data('原生后台进程标识无法解析；结果未知，请核验原操作，不要直接重放。');
      this.exited(undefined); this.busy = false; return;
    }
    // Verify the launch invariant before reporting a start: the observed pid must
    // be its own process group and session, bound by the kernel starttime.
    const verify = await this.runBackgroundCommand(renderNativeBackgroundStatCheck(pid), '/', current);
    if (verify.outcome.state !== 'exited' || verify.outcome.exitCode !== 0) {
      this.data('原生后台进程核验结果未知；请核验原操作，不要直接重放。');
      this.exited(undefined); this.busy = false; return;
    }
    if (verify.output.includes(NATIVE_BACKGROUND_PROC_GONE)) {
      // The business exited before verification; only the private log can report how.
      const tail = await this.runBackgroundCommand(renderNativeBackgroundWatcher(pid, logPath), '/', current);
      const exit = tail.outcome.state === 'exited' ? parseNativeBackgroundExit(tail.output) : undefined;
      if (exit === undefined) this.data('后台进程在核验前退出，但未观察到可确认的退出码；请核验原操作。');
      this.exited(exit); this.busy = false; return;
    }
    const stat = parseNativeBackgroundStat(verify.output, pid);
    if (!stat) {
      this.data('原生后台进程组核验失败；结果未知，请核验原操作，不要直接重放。');
      this.exited(undefined); this.busy = false; return;
    }
    current(); this.clearStartup();
    const abort = new AbortController();
    this.bgWatch = { pid, logPath, processStartTime: stat.processStartTime, current, abort };
    this.started({ pid, logPath, processStartTime: stat.processStartTime });
    // The watcher is deliberately not awaited: its lifetime is the business runtime.
    void this.watchNativeBackground(pid, logPath, current, abort.signal);
  }

  /** One authorized native exec whose stdout/stderr are collected for backend parsing only. */
  private async runBackgroundCommand(command: string, cwd: string, current: () => void,
    signal?: AbortSignal): Promise<{ outcome: NativeExecOutcome; output: string }> {
    let output = '';
    const outcome = await this.ssh.runNativeExec!(this.hostId,
      { command, cwd, envPath: '/usr/bin/env', shellPath: '/bin/sh' },
      () => { current(); return true; },
      { stdout: (data: Buffer) => { if (output.length < 65_536) output += data.toString('utf8'); },
        stderr: () => {} }, signal);
    return { outcome, output };
  }

  /** Detached /proc watcher. Only the private log tail decides the exit code; a lost
   * or aborted watcher never claims an exit and settles the operation as unknown. */
  private async watchNativeBackground(pid: number, logPath: string, current: () => void, signal: AbortSignal): Promise<void> {
    try {
      const tail = await this.runBackgroundCommand(renderNativeBackgroundWatcher(pid, logPath), '/', current, signal);
      const exit = tail.outcome.state === 'exited' ? parseNativeBackgroundExit(tail.output) : undefined;
      if (exit !== undefined && tail.output) this.data(tail.output.slice(-256));
      else if (tail.outcome.state !== 'exited') this.data('后台观察通道中断，结果未知；请核验原任务，不得自动重试。');
      this.exited(exit);
    } catch {
      this.data('后台观察通道中断，结果未知；请核验原任务，不得自动重试。');
      this.exited(undefined);
    } finally {
      this.bgWatch = undefined; this.busy = false;
      if (this.humanOwned && !this.closed) void this.openHuman().catch(() => this.close());
    }
  }

  /** Reviewed stop for the native-background group. Identity is re-verified against
   * /proc (group, session, starttime) immediately before the signal; any mismatch,
   * unreadable state or unconfirmed delivery sends nothing and reports unknown. */
  private async interruptBackground(expectedPid: number): Promise<'sent' | 'already-exited'> {
    const watch = this.bgWatch;
    if (!watch || watch.pid !== expectedPid) throw new Error('Background process identity changed; stop signal not sent');
    watch.current();
    const verify = await this.runBackgroundCommand(renderNativeBackgroundStatCheck(expectedPid), '/', watch.current, watch.abort.signal);
    if (verify.outcome.state !== 'exited' || verify.outcome.exitCode !== 0)
      throw new Error('Background stop pre-check failed; stop signal not sent');
    if (verify.output.includes(NATIVE_BACKGROUND_PROC_GONE)) return 'already-exited';
    const stat = parseNativeBackgroundStat(verify.output, expectedPid);
    if (!stat || stat.processStartTime !== watch.processStartTime)
      throw new Error('Background process identity could not be re-verified (possible PID reuse); stop signal not sent');
    watch.current();
    const stop = await this.runBackgroundCommand(renderNativeBackgroundStop(expectedPid), '/', watch.current, watch.abort.signal);
    if (stop.outcome.state !== 'exited' || stop.outcome.exitCode !== 0)
      throw new Error('Background stop delivery could not be confirmed');
    return 'sent';
  }

  interrupt(expectedPid: number): Promise<'sent' | 'already-exited'> {
    if (this.bgWatch) return this.interruptBackground(expectedPid);
    return Promise.reject(new Error('没有可核验的当前进程；停止信号未发送'));
  }

  answerAuthentication(id: string, answer: string | null): boolean {
    if (answer !== null && (answer.length > 4095 || /[\r\n\u0000]/u.test(answer))) return false;
    if (this.ptySession) return this.ptyChallenges.has(id) && this.ptySession.answer(id, answer);
    return false;
  }

  write(data: string): void {
    if (this.ptySession) { this.ptySession.write(data); return; }
    if (this.nativeAbort) { if (data === '\u0003') this.nativeAbort.abort(); return; }
    if (this.human) this.human.write(data);
    else if (this.humanOwned && !this.closed) {
      void this.openHuman().then((channel) => channel.write(data)).catch(() => this.close());
    }
  }

  private openHuman(): Promise<ClientChannel> {
    // Only explicit human takeover opens an interactive shell; the Agent never receives this route.
    this.humanOpening ??= (this.ssh.integratedShell ? this.ssh.integratedShell(this.hostId, this.cols, this.rows)
      : this.ssh.shell(this.hostId, this.cols, this.rows).then((channel) => ({ channel, nonce: '' }))).then(({ channel, nonce }) => {
      this.command({ phase: 'unavailable' });
      if (this.closed) { channel.end(); throw new Error('Terminal closed'); }
      this.human = channel;
      channel.setWindow(this.rows, this.cols, 0, 0);
      // The banner of a fresh login shell can look like a reconnect; state the handover first.
      this.display(`${this.lineStart ? '' : '\r\n'}—— 终端已交还人工输入 ——\r\n`);
      this.lineStart = true;
      const decoder = new StringDecoder('utf8');
      const parser = new ShellMarkerParser(nonce, (text) => this.data(text), (event) => this.command(event));
      channel.on('data', (chunk: Buffer) => parser.push(decoder.write(chunk)));
      channel.on('close', () => this.close());
      channel.on('error', () => this.close());
      return channel;
    });
    return this.humanOpening;
  }

  takeOver(): void {
    this.clearStartup();
    this.humanOwned = true;
    if (!this.busy && !this.closed) void this.openHuman().catch(() => this.close());
  }

  resize(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows;
    if (this.ptySession) this.ptySession.resize(cols, rows);
    this.human?.setWindow(rows, cols, 0, 0);
  }

  private clearStartup(): void { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
  private armStartup(reject?: (error: Error) => void): void {
    this.clearStartup();
    this.startupTimer = setTimeout(() => {
      this.clearStartup();
      try { this.data('启动观察超时，远端结果未知；不会重放命令，请核验原操作。'); } catch { /* Still revoke this channel. */ }
      try { this.close(); } finally { reject?.(new Error('Command startup observation timed out; verify the original operation')); }
    }, 180_000);
    this.startupTimer.unref?.();
  }

  close(): void {
    this.clearStartup();
    if (this.closed) return;
    this.closed = true;
    this.nativeAbort?.abort();
    this.ptyAbort?.abort();
    this.bgWatch?.abort.abort();
    this.human?.end();
    this.closedListener();
  }
}
