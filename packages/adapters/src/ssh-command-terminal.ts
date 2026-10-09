import { ShellMarkerParser, type ShellCommandEvent } from './shell-integration.js';
import { StringDecoder } from 'node:string_decoder';
import { CommandNotStartedError, isSudo, supportsSudo, type OperationResult, type RawTerminal } from '@cloudhelm/core';
import type { ClientChannel } from 'ssh2';
import { BashAnalyzer } from './bash-analyzer.js';
import type { SshTransport } from './ssh-transport.js';
export type CommandTransport = Pick<SshTransport, 'connectionGeneration' | 'prepareCommandProgram' | 'removeCommandProgram' | 'openPipe' | 'shell'> & Partial<Pick<SshTransport, 'integratedShell'>>;
import { remoteCommandProgram } from './remote-command-program.js';

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
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects'>) => {};
  private exited = (_code: number | undefined) => {};
  private closedListener = () => {};
  private authentication = (_challenge: { id: string; prompt?: string }) => {};
  private readonly generation: number;
  private readonly analyzer = new BashAnalyzer();

  constructor(private readonly ssh: CommandTransport, private readonly hostId: string) {
    this.generation = ssh.connectionGeneration(hostId);
  }

  onData(listener: (text: string) => void): void { this.data = listener; }
  onDisplay(listener: (text: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (code: number | undefined) => void): void { this.exited = listener; }
  onClose(listener: () => void): void { this.closedListener = listener; }
  onAuthentication(listener: (challenge: { id: string; prompt?: string }) => void): void { this.authentication = listener; }

  async execute(command: string, cwd: string, isAuthorized: () => boolean): Promise<void> {
    const current = () => {
      if (this.closed || this.generation !== this.ssh.connectionGeneration(this.hostId) || !isAuthorized()) {
        throw new Error('Command authorization expired');
      }
    };
    current();
    if (this.busy || this.human || this.humanOpening) throw new Error('The command terminal is busy');
    const analysis = await this.analyzer.analyze(command);
    if (analysis.hasError) throw new Error('Command parsing failed');
    const sudo = supportsSudo(analysis);
    if (analysis.calls.some((call) => /(?:^|\/)(?:sudo|su)$/u.test(call.name)) && !sudo) {
      throw new Error('This authentication form requires manual takeover; no command was sent');
    }
    const steps = sudo ? analysis.steps! : undefined;
    const first = analysis.steps?.length === 1 ? analysis.steps[0]!.call : undefined;
    const fallback = first ? [first.name, ...first.args] : ['/bin/bash', '--noprofile', '--norc', '-c', command];
    current();
    try {
      if (!this.program) this.program = await this.ssh.prepareCommandProgram(this.hostId, remoteCommandProgram, current);
    } catch {
      throw new CommandNotStartedError('命令未发送：请确认远端提供 Python 3（POSIX、pty 支持），且 /tmp 可写；修复后再继续。');
    }
    current();
    this.busy = true;
    this.lineStart = true;
    const finish = (code?: number) => {
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
        });
    };
    try { await next(0, 0); }
    catch (error) { this.busy = false; throw error; }
  }

  private async startProcess(argv: string[], cwd: string, sudo: boolean, command: string | undefined,
    current: () => void, onComplete: (code?: number) => void): Promise<void> {
    // The fixed helper is installed via SFTP. Neither command text nor credentials appear in this SSH command.
    const channel = await this.ssh.openPipe(this.hostId, `python3 -I -u ${this.program} --serve`);
    try { current(); } catch (error) { channel.end(); channel.close(); throw error; }
    this.active = channel;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let completed = false;
    const complete = (code?: number) => {
      if (completed) return;
      completed = true;
      this.active = undefined;
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
          else if (event.type === 'launch-error' && ['permission-denied', 'unsupported'].includes(String(event.kind))) {
            this.failure({ failureKind: event.kind as 'permission-denied' | 'unsupported', effects: this.precedingSteps ? 'possible' : 'none' });
            this.data(event.kind === 'unsupported' ? '命令未启动：所需工具或工作目录不存在。请确认工具已安装、路径正确后继续。' : '命令未启动：当前身份无权访问工具或工作目录。请核验权限后提交新的审核操作。'); complete(127); return;
          }
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
    channel.write(`${JSON.stringify({ argv, cwd, sudo, command, cols: this.cols, rows: this.rows })}\n`);
  }

  answerAuthentication(id: string, answer: string | null): boolean {
    if (!this.active || !this.challenges.has(id) || (answer !== null && (answer.length > 4095 || /[\r\n\u0000]/u.test(answer)))) return false;
    this.challenges.delete(id);
    this.active.write(`${JSON.stringify({ type: 'answer', id, answer })}\n`);
    return true;
  }

  write(data: string): void {
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
    this.humanOwned = true;
    if (!this.busy && !this.closed) void this.openHuman().catch(() => this.close());
  }

  resize(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows;
    if (this.active) this.active.write(`${JSON.stringify({ type: 'resize', cols, rows })}\n`);
    this.human?.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.end(); this.active?.close(); this.human?.end();
    this.closedListener();
    if (this.program && this.generation === this.ssh.connectionGeneration(this.hostId)) {
      void this.ssh.removeCommandProgram(this.hostId, this.program).catch(() => {});
    }
  }
}
