import { ShellMarkerParser, type ShellCommandEvent } from './shell-integration.js';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { CommandNotStartedError, isSudo, nativeCommandEligible, nativePtySudoEligible, redactOutput, sudoMarkerPrompt, sudoPtyCommand, supportsSudo,
  type CommandAnalysis, type OperationResult, type RawTerminal } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';
import { BashAnalyzer } from './bash-analyzer.js';
import type { SshTransport } from './ssh-transport.js';
export type CommandTransport = Pick<SshTransport, 'connectionGeneration' | 'prepareCommandProgram' | 'removeCommandProgram' | 'openPipe' | 'shell'> & Partial<Pick<SshTransport, 'integratedShell' | 'runNativeExec' | 'runNativePty' | 'execFixed'>>;
import { ProcessInterrupt } from './ssh-process-signal.js';
import { remoteCommandProgram } from './remote-command-program.js';
import type { NativePtyHandle, NativePtyOutcome } from './native-ssh-pty.js';

/** Commands are process arguments; PTY input and sudo credentials have distinct channels. */
export class SshCommandTerminal implements RawTerminal {
  private program?: string;
  private active?: ClientChannel;
  private human?: ClientChannel;
  private humanOpening?: Promise<ClientChannel>;
  private humanOwned = false;
  private closed = false;
  private busy = false;
  private precedingSteps = false;
  private cols = 100;
  private rows = 30;
  private prompt = '';
  private syntheticPromptShown = false;
  private lineStart = true;
  private challenges = new Set<string>();
  private command = (_event: ShellCommandEvent) => {};
  onCommand(listener: (event: ShellCommandEvent) => void): void { this.command = listener; }
  private data = (_text: string) => {};
  private display = (_text: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>) => {};
  private exited = (_code: number | undefined) => {};
  private closedListener = () => {};
  private authentication = (_challenge: { id: string; prompt?: string }) => {};
  private started = (_event: { pid: number }) => {};
  private interrupter?: ProcessInterrupt;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private nativeAbort?: AbortController;
  private ptySession?: NativePtyHandle;
  private ptyAbort?: AbortController;
  private readonly ptyChallenges = new Set<string>();
  private readonly generation: number;
  private readonly analyzer = new BashAnalyzer();

  constructor(private readonly ssh: CommandTransport, private readonly hostId: string) {
    this.generation = ssh.connectionGeneration(hostId);
  }

  onData(listener: (text: string) => void): void { this.data = listener; }
  onDisplay(listener: (text: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onProcessStarted(listener: (event: { pid: number }) => void): void { this.started = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onClose(listener: () => void): void { this.closedListener = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.authentication = listener; }

  async execute(command: string, cwd: string, isAuthorized: () => boolean, options?: { sudoAuthorization?: boolean; executionChannel?: 'native-exec' | 'native-pty' }): Promise<void> {
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
    options?: { sudoAuthorization?: boolean; executionChannel?: 'native-exec' | 'native-pty' }): Promise<void> {
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
      if (!nativePtySudoEligible({ id: '', kind: 'command', command, scope: { taskId: '', hostId: this.hostId,
        cwd, runAs: '', terminalId: '', terminalGeneration: 0, policyRevision: 0,
        allowedWorkingRoots: [], protectedPaths: [], goal: '' } }, analysis))
        throw new CommandNotStartedError('Native PTY review no longer matches command; nothing sent');
      await this.executeNativePty(cwd, current, analysis);
      return;
    }
    const sudo = supportsSudo(analysis);
    if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name)) && !sudo) {
      throw new Error('This authentication form requires manual takeover; no command was sent');
    }
    const steps = sudo ? analysis.steps! : undefined;
    const first = analysis.steps?.length === 1 ? analysis.steps[0]!.call : undefined;
    const fallback = first ? [first.name, ...first.args] : ['/bin/bash', '--noprofile', '--norc', '-c', command];
    current();
    try {
      if (!this.program) {
        const program = await this.ssh.prepareCommandProgram(this.hostId, remoteCommandProgram, current);
        if (this.closed) {
          if (this.generation === this.ssh.connectionGeneration(this.hostId)) void this.ssh.removeCommandProgram(this.hostId, program).catch(() => {});
          throw new Error('Command channel closed during preparation');
        }
        this.program = program;
      }
    } catch (error) {
      // Keep the concrete transport cause visible; the generic checklist alone hides what to fix.
      const cause = redactOutput(error instanceof Error ? error.message : String(error)).trim().slice(0, 300);
      throw new CommandNotStartedError(`命令未发送：${cause || '远端执行通道准备失败'}。请确认远端提供 Python 3（POSIX、pty 支持）、/tmp 可写且 SFTP 可用；修复后再继续。`);
    }
    current();
    this.busy = true;
    this.lineStart = true;
    const finish = (code?: number) => {
      this.clearStartup();
      this.busy = false;
      // The exit report can synchronously hand the terminal back to the human owner;
      // decide on the synthetic prompt only after that handover is known.
      try { this.exited(code); }
      finally {
        if (code !== undefined && !this.humanOwned && !this.closed) {
          this.display(`${this.lineStart ? '' : '\r\n'}${this.prompt}`);
          this.syntheticPromptShown = true;
        }
        if (this.humanOwned && !this.closed) void this.openHuman().catch(() => this.close());
      }
    };
    const next = async (index: number, code: number): Promise<void> => {
      while (steps && index < steps.length) {
        const condition = steps[index]!.condition;
        if ((condition === 'success' && code !== 0) || (condition === 'failure' && code === 0)) index++;
        else break;
      }
      if (index >= (steps?.length ?? 1)) { finish(code); return; }
      current();
      const step = steps?.[index];
      this.precedingSteps = index > 0;
      await this.startProcess(step ? [step.call.name, ...step.call.args] : fallback, cwd,
        !!step && isSudo(step.call), index === 0 ? command : undefined, current, (exitCode) => {
          if (exitCode === undefined) { finish(); return; }
          void next(index + 1, exitCode).catch(() => finish());
        }, options?.sudoAuthorization === true);
    };
    try { await next(0, 0); }
    catch (error) { this.busy = false; throw error; }
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

  /** sudo on the credential-bound native PTY: the password reaches only the
   * client-owned marker window, never command text, output, or logs. */
  private async executeNativePty(cwd: string, current: () => void, analysis: CommandAnalysis): Promise<void> {
    if (!this.ssh.runNativePty) {
      this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      this.exited(undefined); this.busy = false; return;
    }
    current();
    const nonce = randomBytes(16).toString('hex');
    const rebuilt = sudoPtyCommand(analysis, sudoMarkerPrompt(nonce));
    if (!rebuilt) throw new CommandNotStartedError('Native PTY command cannot be rebuilt for this sudo form; nothing sent');
    current(); this.clearStartup();
    const controller = new AbortController(); this.ptyAbort = controller;
    const session = this.ssh.runNativePty(this.hostId,
      { command: rebuilt, cwd, envPath: '/usr/bin/env', shellPath: '/bin/sh', nonce, cols: this.cols, rows: this.rows },
      () => { current(); return true; },
      { data: (text: string) => { if (text) { this.lineStart = text.endsWith('\n'); this.data(text); } },
        authentication: (event: { id: string; open: boolean }) => {
          if (!/^[a-f0-9]{32}$/u.test(event.id)) return;
          if (event.open) { this.ptyChallenges.add(event.id); this.authentication({ id: event.id, prompt: 'sudo 身份验证' }); }
          else { this.ptyChallenges.delete(event.id); this.authentication({ id: event.id }); }
        } },
      controller.signal);
    this.ptySession = session;
    try {
      const outcome: NativePtyOutcome = await session.result;
      if (outcome.state === 'not-dispatched') this.failure({ failureKind: 'not-dispatched', effects: 'none' });
      if (outcome.state === 'exited') {
        if (outcome.exitCode === 127) {
          // A shell-reported missing sudo differs from sudo's own child diagnostic:
          // only the first can offer the reviewed su alternative.
          this.failure({ failureKind: 'unsupported', effects: 'none',
            ...(outcome.sudoMissing ? { privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable',
              source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } as const } : {}) });
        } else if (outcome.exitCode === 125 && !outcome.markerSeen) {
          // The wrapper reports a failed directory change before sudo ever starts.
          this.failure({ failureKind: 'permission-denied', effects: 'none' });
        }
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

  private async startProcess(argv: string[], cwd: string, sudo: boolean, command: string | undefined,
    current: () => void, onComplete: (code?: number) => void, sudoAuthorization = false): Promise<void> {
    // Subsequent supervised steps get their own startup bound, never a payload-runtime bound.
    if (!this.startupTimer) this.armStartup();
    // The fixed helper is installed via SFTP. Neither command text nor credentials appear in this SSH command.
    let channel: ClientChannel;
    try {
      channel = await this.ssh.openPipe(this.hostId, `python3 -I -u ${this.program} --serve`);
      if (channel.destroyed || channel.writableEnded) { channel.close(); throw new Error('Channel closed before handoff'); }
    } catch {
      // Only the fixed helper was requested; no business header/argv has been written.
      throw new CommandNotStartedError('命令执行通道未建立或已关闭，业务命令未发送。');
    }
    try { current(); } catch (error) { channel.end(); channel.close(); throw error; }
    this.active = channel;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let completed = false;
    let authorizationContinued = false;
    let startObserved = false;
    const complete = (code?: number) => {
      if (completed) return;
      completed = true;
      this.clearStartup();
      this.active = undefined;
      this.interrupter?.close(); this.interrupter = undefined;
      for (const id of this.challenges) this.authentication({ id });
      this.challenges.clear();
      channel.end();
      onComplete(code);
    };
    channel.on('data', (data: Buffer) => {
      if (completed) return;
      buffer += decoder.write(data);
      if (buffer.length > 1_048_576) { complete(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        if (completed) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'data' && typeof event.data === 'string') {
            this.data(event.data);
            if (event.data) { this.lineStart = event.data.endsWith('\n'); this.syntheticPromptShown = false; }
          } else if (event.type === 'display' && typeof event.data === 'string') {
            this.display(event.data);
            this.syntheticPromptShown = false;
          }
          else if (event.type === 'prompt' && typeof event.data === 'string') this.prompt = event.data;
          else if (event.type === 'launch-error' && !startObserved && ['permission-denied', 'unsupported'].includes(String(event.kind))) {
            this.failure({ failureKind: event.kind as 'permission-denied' | 'unsupported', effects: this.precedingSteps ? 'possible' : 'none',
              ...(sudo && event.code === 'sudo-unavailable' ? { privilege: { method: 'sudo', stage: 'preparation', code: 'sudo-unavailable',
                source: 'transport', businessCommand: this.precedingSteps ? 'unknown' : 'not-started', recovery: this.precedingSteps ? 'verify' : 'confirm-alternative' } as const } : {}) });
            this.data(event.kind === 'unsupported' ? '命令未启动：所需工具或工作目录不存在。请确认工具已安装、路径正确后继续。' : '命令未启动：当前身份无权访问工具或工作目录。请核验权限后提交新的审核操作。'); complete(127); return;
          }
          else if (['sudo-authorized', 'sudo-policy-unconfirmed'].includes(String(event.type)) && sudo && sudoAuthorization && !authorizationContinued) {
            current();
            authorizationContinued = true;
            channel.write('{"type":"continue-authorized"}\n');
          }
          else if (event.type === 'sudo-authorization-failed' && sudo && sudoAuthorization && !authorizationContinued
            && ['authorization-denied', 'authentication-rejected', 'authentication-unconfirmed'].includes(String(event.code))) {
            this.failure({ failureKind: 'authentication-failed', effects: this.precedingSteps ? 'possible' : 'none',
              privilege: { method: 'sudo', stage: event.code === 'authorization-denied' ? 'authorization' : 'authentication',
                code: event.code as 'authorization-denied' | 'authentication-rejected' | 'authentication-unconfirmed',
                source: 'transport', businessCommand: this.precedingSteps ? 'unknown' : 'not-started',
                recovery: this.precedingSteps ? 'verify' : event.code === 'authorization-denied' ? 'confirm-alternative' : 'user-action' } });
            this.data('sudo 未完成本次命令的授权或认证；业务命令尚未启动。'); complete(1); return;
          }
          else if (event.type === 'process-started' && !startObserved && Number.isSafeInteger(event.pid)
            && (event.pid as number) > 0 && (event.pid as number) <= 2147483647
            && (!sudo || !sudoAuthorization || authorizationContinued)) {
            current();
            startObserved = true;
            this.clearStartup();
            this.interrupter = new ProcessInterrupt(event.pid as number, current,
              (message) => channel.write(`${JSON.stringify(message)}\n`));
            this.started({ pid: event.pid as number });
          }
          else if (event.type === 'signal-result' && this.interrupter?.receive(event)) { /* Signal acknowledgement, not exit. */ }
          else if (event.type === 'exit' && Number.isInteger(event.code)) { complete(event.code as number); return; }
          else if (event.type === 'auth' && typeof event.id === 'string' && /^[a-f0-9]{32}$/u.test(event.id)) {
            this.challenges.add(event.id);
            this.authentication({ id: event.id, prompt: 'sudo 身份验证' });
          } else if (event.type === 'auth-close' && typeof event.id === 'string') {
            this.challenges.delete(event.id); this.authentication({ id: event.id });
          } else { this.data('命令执行通道异常，请核验远端结果后再继续。'); complete(); return; }
        } catch { complete(); return; }
      }
    });
    channel.stderr.on('data', () => { this.data('无法启动命令执行组件，请确认远端 Python 3 可用。'); complete(); });
    channel.on('error', () => complete());
    channel.on('close', () => complete());
    current();
    channel.write(`${JSON.stringify({ argv, cwd, sudo, command, cols: this.cols, rows: this.rows, ...(sudo && sudoAuthorization ? { sudoAuthorization: true } : {}) })}\n`);
  }

  interrupt(expectedPid: number): Promise<'sent' | 'already-exited'> {
    return this.interrupter?.interrupt(expectedPid) ?? Promise.reject(new Error('没有可核验的当前进程；停止信号未发送'));
  }

  answerAuthentication(id: string, answer: string | null): boolean {
    if (answer !== null && (answer.length > 4095 || /[\r\n\u0000]/u.test(answer))) return false;
    if (this.ptySession) return this.ptyChallenges.has(id) && this.ptySession.answer(id, answer);
    if (!this.active || !this.challenges.has(id)) return false;
    this.challenges.delete(id);
    this.active.write(`${JSON.stringify({ type: 'answer', id, answer })}\n`);
    return true;
  }

  write(data: string): void {
    if (this.ptySession) { this.ptySession.write(data); return; }
    if (this.nativeAbort) { if (data === '\u0003') this.nativeAbort.abort(); return; }
    if (this.active) this.active.write(`${JSON.stringify({ type: 'input', data: Buffer.from(data).toString('base64') })}\n`);
    else if (this.human) this.human.write(data);
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
      // The banner of a fresh login shell can look like a reconnect; state the handover
      // first and erase the synthetic prompt left on screen by the finished command.
      this.display(`${this.syntheticPromptShown ? '\r\x1b[2K' : this.lineStart ? '' : '\r\n'}—— 终端已交还人工输入 ——\r\n`);
      this.syntheticPromptShown = false;
      this.lineStart = true;
      const decoder = new StringDecoder('utf8');
      const parser = new ShellMarkerParser(nonce, (text) => this.data(text), (event) => this.command(event));
      channel.on('data', (chunk: Buffer) => { this.syntheticPromptShown = false; parser.push(decoder.write(chunk)); });
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
    else if (this.active) this.active.write(`${JSON.stringify({ type: 'resize', cols, rows })}\n`);
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
    this.interrupter?.close(); this.interrupter = undefined;
    this.active?.end(); this.active?.close(); this.human?.end();
    this.closedListener();
    if (this.program && this.generation === this.ssh.connectionGeneration(this.hostId)) {
      void this.ssh.removeCommandProgram(this.hostId, this.program).catch(() => {});
    }
  }
}
