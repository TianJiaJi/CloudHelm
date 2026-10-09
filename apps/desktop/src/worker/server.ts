import { PrivilegedRuntime } from './privileged-runtime.js';
import { safeDiagnostic } from '@cloudhelm/core';
import { eventDiagnostic } from './diagnostic-events.js';
import { HostSerialExecutor, PermissionAwareExecutor, InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, HostKeyError, SshCommandTerminal, SshTransport, type SshHost, type SshLoginPrompt } from '@cloudhelm/adapters';
import { randomUUID } from 'node:crypto';
import type { RawTerminal } from '@cloudhelm/core';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import type { LogPage, RuntimeCall, RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
import { TaskRunner } from './task-runner.js';
import { OperationInputBridge } from './operation-input-bridge.js';
import { testModelConnection } from '@cloudhelm/adapters';
import { FileOperationExecutor } from './file-operation-executor.js';
import { testHostConnection } from './host-connection-test.js';

export class WorkerServer {
  private readonly logRequests = new Map<string, { resolve(value: LogPage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly ssh = new SshTransport((hostId) => {
    for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(hostId)) runner.pause();
    this.terminal.closeHost(hostId);
    this.post({ event: { type: 'host-status', hostId, status: 'disconnected' } });
  });
  private readonly terminal: TerminalManager;
  private readonly executor: HostSerialExecutor;
  private readonly privileged: PrivilegedRuntime;
  private readonly commands: OperationInputBridge;
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly interactions: InteractionCoordinator;
  private readonly tasks = new Map<string, TaskRunner>();
  private readonly pendingApprovals = new Map<string, { hostId: string; resolve(allowed: boolean): void }>();
  private readonly pendingInputs = new Map<string, { connectionId: string; expiresAt: number; resolve(answer: string | null): void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly send: (message: RuntimeMessage) => void) {
    this.terminal = new TerminalManager({
      data: (terminalId, data, operationId) => this.post({ event: { type: 'terminal-data', terminalId, data, operationId } }),
      completed: (result) => {
        const hostId = result.logRef ? this.terminal.hostOf(result.logRef) : undefined;
        if (hostId) this.executor?.observe(hostId, result);
        for (const runner of this.tasks.values()) runner.recordRemoteResult(result);
      },
      state: (terminalId, state) => {
        if (state !== 'agent') { this.interactions?.cancelForTerminal(terminalId); this.commands?.clearTerminal(terminalId); }
        this.post({ event: { type: 'terminal-state', terminalId,
          hostId: this.terminal.hostOf(terminalId) ?? '', taskId: this.terminal.taskOf(terminalId), state } });
      }
    });
    this.interactions = new InteractionCoordinator(this.terminal, {
      opened: (request) => this.post({ event: { type: 'input-open', value: {
        id: request.id, taskId: request.taskId, operationId: request.operationId, hostId: request.hostId,
        title: request.prompt, explanation: `${request.reason} 接收方：${request.recipient}`, kind: request.kind,
        choices: request.choices, expiresAt: request.expiresAt
      } } }),
      closed: (id) => this.post({ event: { type: 'input-close', id } })
    });
    this.commands = new OperationInputBridge(this.terminal, this.ssh, this.interactions,
      (taskId, hostId) => this.post({ event: { type: 'task-message', taskId, role: 'system',
        text: `已审核的安装操作在主机 ${hostId} 上需要普通继续确认，APT 报告 0 项删除，已自动回答 y。`, createdAt: Date.now() } }),
      (taskId, hostId, operationId) => this.post({ diagnostic: { event: 'authentication.reused', taskId, hostId, operationId } }));
    this.privileged = new PrivilegedRuntime({ terminal: this.terminal, ssh: this.ssh,
      ordinary: new FileOperationExecutor(this.terminal, this.ssh, this.commands),
      jump: (host) => host.jumpHostId ? this.hosts.get(host.jumpHostId) : undefined,
      input: (request, signal) => this.requestPrivateInput(request, signal) });
    this.executor = new HostSerialExecutor(new PermissionAwareExecutor(this.privileged, new BashAnalyzer()));
  }

  private post(message: RuntimeMessage): void {
    const diagnostic = eventDiagnostic(message);
    if (diagnostic) this.send({ diagnostic });
    this.send(message);
  }

  async dispatch(call: RuntimeCall): Promise<unknown> {
    switch (call.method) {
      case 'restore-operations': return this.executor.restore(call.operations);
      case 'has-task': return this.tasks.has(call.taskId);
      case 'set-review-key':
        for (const runner of this.tasks.values()) runner.setReviewKey(call.jevKey);
        return;
      case 'test-model': return testModelConnection(call.profile);
      case 'set-conversation-thinking': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话尚未恢复');
        runner.setThinking(call.level); return;
      }
      case 'set-conversation-model': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话尚未恢复');
        runner.setModel(call.profile); return;
      }
      case 'stop-operation': return this.tasks.get(call.taskId)?.stopOperation();
      case 'disconnect':
        for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(call.hostId)) runner.pause();
        this.terminal.closeHost(call.hostId);
        this.ssh.disconnect(call.hostId);
        return;
      case 'connect': return this.connect(call.host, call.jump);
      case 'test-host': return testHostConnection(call.host, call.jump);
      case 'update-host-safety':
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.hostId === call.hostId) this.cancelApproval(id);
        }
        for (const runner of this.tasks.values()) runner.updateHostSafety(call.hostId, call.mode, call.protectedPaths, call.revision);
        return;
      case 'open-terminal': return this.openTerminal(call.hostId);
      case 'close-terminal':
        this.interactions.cancelForTerminal(call.terminalId);
        for (const runner of this.tasks.values()) if (runner.ownsTerminal(call.terminalId)) runner.stopOperation('terminal-close');
        if (this.terminal.hostOf(call.terminalId)) this.terminal.close(call.terminalId);
        return;
      case 'terminal-input': {
        const taskId = this.terminal.taskOf(call.terminalId);
        const runner = taskId ? this.tasks.get(taskId) : undefined;
        if (call.humanIntent && taskId) {
          if (!runner) throw new Error('对话运行已失效，请重新打开终端');
          return runner.terminalInput(call.terminalId, call.data);
        }
        this.terminal.input(call.terminalId, call.data, call.humanIntent);
        return;
      }
      case 'stop-terminal': {
        const taskId = this.terminal.taskOf(call.terminalId);
        if (taskId) this.tasks.get(taskId)?.terminalInput(call.terminalId, '\u0003');
        else this.terminal.input(call.terminalId, '\u0003', true);
        return;
      }
      case 'resize': return this.terminal.resize(call.terminalId, call.cols, call.rows);
      case 'list-remote': return this.ssh.list(call.hostId, call.path);
      case 'start-task': {
        if (!call.task.session || call.task.session.id !== call.task.id || !call.sessionDirectory) throw new Error('Native session binding required');
        if (!call.restored) this.send({ diagnostic: safeDiagnostic({ event: 'chat', level: 'info', taskId: call.task.id, role: 'user', text: call.task.goal }) });
        if (this.tasks.has(call.task.id)) throw new Error('Task is already active');
        const runner = new TaskRunner(call.task, call.hosts, call.profile, call.priorOperations ?? [], this.terminal, this.executor,
          (hostId, taskId) => this.openTerminal(hostId, taskId), {
            clearCredentials: () => this.commands.clearTask(call.task.id),
            diagnostic: (diagnostic) => this.send({ diagnostic: safeDiagnostic(diagnostic) }),
            event: (event) => this.post({ event } as RuntimeMessage),
            requestApproval: (view) => this.requestApproval(view),
            cancelApproval: (id) => this.cancelApproval(id)
          }, (operationId, cursor) => this.readLog(call.task.id, operationId, cursor), this.privileged.forTask(call.task.id),
          { id: call.task.session.id, directory: call.sessionDirectory, restore: !!call.restored });
        this.tasks.set(call.task.id, runner);
        const start = runner.start(call.restored, call.thinkingLevel);
        if (call.restored) {
          try { await start; } catch (error) { this.tasks.delete(call.task.id); runner.dispose(); throw error; }
        }
        else void start.catch((error: unknown) => {
          this.tasks.delete(call.task.id); runner.dispose();
          this.post({ event: { type: 'task-status', taskId: call.task.id, status: 'failed', summary: error instanceof Error ? error.message : String(error) } });
        });
        return;
      }
      case 'authorize-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('Task runtime is unavailable; resume it before changing authorization');
        runner.addAuthorization(call.hosts, call.localScopes);
        return;
      }
      case 'answer-clarification':
      case 'cancel-clarification': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效，请重新发送需求');
        if (call.method === 'answer-clarification') return runner.answerClarification(call.requestId, call.answers);
        return runner.cancelClarification(call.requestId);
      }
      case 'task-message': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('请先恢复对话');
        return runner.message(call.text);
      }
      case 'decide-approval': {
        const pending = this.pendingApprovals.get(call.approvalId);
        if (!pending) throw new Error('Approval expired');
        this.pendingApprovals.delete(call.approvalId);
        pending.resolve(call.approved);
        this.post({ event: { type: 'approval-close', id: call.approvalId } });
        return;
      }
      case 'answer-input': return this.pendingInputs.has(call.requestId)
        ? this.answerInput(call.requestId, call.answer) : this.interactions.answer(call.requestId, call.answer);
      case 'cancel-input': return this.pendingInputs.has(call.requestId)
        ? this.answerInput(call.requestId, null) : this.interactions.cancel(call.requestId);
      case 'pause-task': return this.tasks.get(call.taskId)?.pause();
      case 'resume-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('Task runtime is unavailable; reopen the application to reconcile');
        this.resumeTask(runner);
        return;
      }
      case 'delete-task': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) return;
        if (!runner.canDelete) throw new Error('对话仍在运行，无法删除');
        await runner.close();
        this.tasks.delete(call.taskId);
        return;
      }
    }
  }

  private resumeTask(runner: TaskRunner): void {
    void runner.resume().catch((error: unknown) => this.post({ event: {
      type: 'task-status', taskId: runner.task.id, status: 'failed', summary: error instanceof Error ? error.message : String(error)
    } }));
  }

  resolveLog(result: { id: string; value?: LogPage; error?: string }): void {
    const pending = this.logRequests.get(result.id);
    if (!pending) return;
    this.logRequests.delete(result.id);
    clearTimeout(pending.timer);
    if (result.value) pending.resolve(result.value);
    else pending.reject(new Error(result.error ?? 'Log unavailable'));
  }

  private readLog(taskId: string, operationId: string, cursor: number): Promise<LogPage> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.logRequests.delete(id); reject(new Error('Log request expired')); }, 5000);
      this.logRequests.set(id, { resolve, reject, timer });
      this.post({ readLog: { id, taskId, operationId, cursor } });
    });
  }

  private requestPrivateInput(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    const id = randomUUID(); const expiresAt = Date.now() + 120_000;
    return new Promise((resolve) => {
      const abort = () => { if (this.pendingInputs.has(id)) this.answerInput(id, null); };
      const timeout = setTimeout(abort, 120_000);
      this.pendingInputs.set(id, { connectionId: request.operationId, expiresAt, timeout,
        resolve: (answer) => { signal.removeEventListener('abort', abort); resolve(answer); } });
      signal.addEventListener('abort', abort, { once: true });
      this.post({ event: { type: 'input-open', value: { ...request, id, expiresAt } } });
      if (signal.aborted) abort();
    });
  }

  private async connect(host: RuntimeHost, jump?: RuntimeHost): Promise<void> {
    const connectionId = randomUUID();
    this.hosts.set(host.id, host);
    if (jump) this.hosts.set(jump.id, jump);
    try {
      await this.ssh.connect(host as SshHost, { password: host.secret, passphrase: host.secret },
        jump ? { host: jump as SshHost, secret: { password: jump.secret, passphrase: jump.secret } } : undefined,
        (prompt) => this.requestLoginInput(connectionId, host, prompt));
      this.post({ event: { type: 'host-status', hostId: host.id, status: 'connected' } });
    } catch (error) {
      this.post({ event: { type: 'host-status', hostId: host.id, status: error instanceof HostKeyError ? 'changed-key' : 'error' } });
      throw error;
    } finally {
      for (const [id, pending] of this.pendingInputs) if (pending.connectionId === connectionId) this.answerInput(id, null);
    }
  }

  private requestLoginInput(connectionId: string, host: RuntimeHost, prompt: SshLoginPrompt): Promise<string | null> {
    const id = randomUUID();
    const expiresAt = Date.now() + 120_000;
    const kind = /otp|one.time|verification|验证码|动态码|令牌/u.test(prompt.text.toLowerCase()) ? 'otp'
      : prompt.echo ? 'text' : 'secret';
    const request: InputRequestView = {
      id, taskId: '', operationId: `ssh-login:${connectionId}`, hostId: host.id,
      title: kind === 'otp' ? 'SSH 登录需要验证码' : kind === 'secret' ? 'SSH 登录需要身份验证' : 'SSH 登录需要输入',
      explanation: `正在连接 ${host.label}（${host.address}）并登录账户 ${prompt.username}。服务器通过 SSH 登录认证请求这项信息，回答仅发送给本次认证会话，AI 不会看到。服务器提示：${prompt.text.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300)}`,
      kind, expiresAt
    };
    this.post({ event: { type: 'input-open', value: request } });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.answerInput(id, null), 120_000);
      this.pendingInputs.set(id, { connectionId, expiresAt, resolve, timeout });
    });
  }

  private answerInput(id: string, answer: string | null): void {
    const pending = this.pendingInputs.get(id);
    if (!pending) throw new Error('Input request expired');
    this.pendingInputs.delete(id);
    clearTimeout(pending.timeout);
    this.post({ event: { type: 'input-close', id } });
    pending.resolve(Date.now() < pending.expiresAt ? answer : null);
  }

  private async openTerminal(hostId: string, taskId?: string): Promise<string> {
    const probe = taskId ? await this.ssh.execFixed(hostId, 'pwd -P') : undefined;
    if (probe && (probe.exitCode !== 0 || !probe.output.trim().startsWith('/') || probe.output.trim().includes('\n'))) throw new Error('无法核验 Agent 登录目录');
    if (taskId) return this.terminal.open(hostId, new SshCommandTerminal(this.ssh, hostId), taskId, probe!.output.trim());
    const channel = await this.ssh.shell(hostId);
    const raw: RawTerminal = {
      write: (data) => channel.write(data),
      resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
      close: () => channel.end(),
      onData: (listener) => { channel.on('data', (data: Buffer) => listener(data.toString('utf8'))); },
      onClose: (listener) => { channel.on('close', listener); }
    };
    return this.terminal.open(hostId, raw, taskId, probe?.output.trim() || '/');
  }

  private requestApproval(view: ApprovalView): Promise<boolean> {
    this.post({ event: { type: 'approval-open', value: view } });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(view.id);
        this.post({ event: { type: 'approval-close', id: view.id } });
        resolve(false);
      }, Math.max(0, view.expiresAt - Date.now()));
      this.pendingApprovals.set(view.id, { hostId: view.hostId, resolve: (allowed) => { clearTimeout(timeout); resolve(allowed); } });
    });
  }

  private cancelApproval(id: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    pending.resolve(false);
    this.post({ event: { type: 'approval-close', id } });
  }
}
