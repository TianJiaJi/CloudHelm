import { MessagePreparations } from './message-preparations.js';
import { ShellMarkerParser } from '@cloudhelm/adapters';
import { createTerminalCodec } from '@cloudhelm/adapters';
import { PrivilegedRuntime } from './privileged-runtime.js';
import { ApprovalInterruptedError, commandEnvironmentFacts, type ApprovalInterruption, resolveHostRiskDomain, safeDiagnostic } from '@cloudhelm/core';
import { eventDiagnostic, reservationDiagnostic } from './diagnostic-events.js';
import { HostEnvironmentRegistry, HostSerialExecutor, PermissionAwareExecutor, InteractionCoordinator, TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, HostKeyError, SshCommandTerminal, SshTransport, type SshHost, type SshLoginPrompt } from '@cloudhelm/adapters';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RawTerminal } from '@cloudhelm/core';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import type { LogPage, RuntimeCall, RuntimeHost, RuntimeMessage } from '@cloudhelm/contracts/runtime';
/** Bounded read for the model's edit loop; reading more than this requires a narrower ask. */
const REMOTE_READ_LIMIT = 128 * 1024;
import { assertRemoteReadAllowed, resolveRemoteReadTarget } from './remote-read-guard.js';
import { TaskRunner } from './task-runner.js';
import { assertCommittedRiskAcceptance } from './risk-acceptance.js';
import { OperationInputBridge } from './operation-input-bridge.js';
import { testModelConnection } from '@cloudhelm/adapters';
import { FileOperationExecutor } from './file-operation-executor.js';
import { ManualSessionAuthorization } from './manual-session-authorization.js';
import { runtimeSshCredentials } from '@cloudhelm/contracts/runtime';
import { testHostConnection } from './host-connection-test.js';
import { InputCommitClient } from './input-commit-client.js';
import { OperationCommitClient } from './operation-commit-client.js';
import { RequestBudgetClient } from './request-budget-client.js';

export class WorkerServer {
  private readonly budget: RequestBudgetClient;
  private readonly operationCommits: OperationCommitClient;
  private readonly inputCommits: InputCommitClient;
  private readonly deliveredMessages = new Set<string>();
  private readonly preparations: MessagePreparations;
  private readonly logRequests = new Map<string, { resolve(value: LogPage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly ssh = new SshTransport((hostId) => {
    this.manualSessions?.disconnect(hostId);
    for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(hostId)) {
      this.preparations.cancelTask(runner.task.id); runner.pause();
    }
    this.terminal.closeHost(hostId);
    this.post({ event: { type: 'host-status', hostId, status: 'disconnected' } });
  });
  private readonly environment = new HostEnvironmentRegistry({
    connectionId: (hostId) => this.ssh.connectionId(hostId),
    read: (hostId, loginAs, signal) => this.ssh.readEnvironment(hostId, loginAs, signal)
  });
  private readonly manualSessions = new ManualSessionAuthorization({
    generation: (hostId) => this.ssh.connectionGeneration(hostId), connected: (hostId) => this.ssh.isConnected(hostId),
    input: (request, signal) => this.requestPrivateInput(request, signal)
  });
  private readonly terminal: TerminalManager;
  private readonly executor: HostSerialExecutor;
  private readonly privileged: PrivilegedRuntime;
  private readonly commands: OperationInputBridge;
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly connectionAttempts = new Map<string, AbortController>();
  private readonly interactions: InteractionCoordinator;
  private readonly tasks = new Map<string, TaskRunner>();
  private readonly pendingApprovals = new Map<string, { taskId: string; hostId: string; expiresAt: number;
    resolve(allowed: boolean): void; reject(error: Error): void }>();
  private readonly pendingInputs = new Map<string, { connectionId: string; expiresAt: number; resolve(answer: string | null): void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly send: (message: RuntimeMessage) => void) {
    this.inputCommits = new InputCommitClient((message) => this.post(message));
    this.operationCommits = new OperationCommitClient((message) => this.post(message));
    this.budget = new RequestBudgetClient((message) => this.post(message), 30_000, (command, value) => {
      const diagnostic = reservationDiagnostic(command, value); if (diagnostic) this.send({ diagnostic });
    });
    this.preparations = new MessagePreparations(this.budget, (event) => this.post({ event }));
    this.terminal = new TerminalManager({
      command: (terminalId, generation, event) => this.post({ event: { type: 'terminal-command', terminalId, generation, ...event } }),
      cwd: (terminalId, directory) => this.post({ event: { type: 'terminal-cwd', terminalId, directory, updatedAt: Date.now() } }),
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
      ordinary: new FileOperationExecutor(this.terminal, this.ssh, this.commands, (operation, signal, attempt) => this.requestPrivateInput({
        taskId: operation.scope.taskId, hostId: operation.scope.hostId, operationId: operation.id, kind: 'secret',
        title: `文件事务 sudo 身份验证（${attempt}/3）`,
        explanation: `接收方：当前主机上本次文件事务的独立 sudo 认证进程；登录账号 ${operation.scope.loginAs ?? operation.scope.runAs}，终端代次 ${operation.scope.terminalGeneration}。密码不进入模型、文件正文、普通输入或日志；取消不会切换身份或重放。`
      }, signal)),
      jump: (host) => host.jumpHostId ? this.hosts.get(host.jumpHostId) : undefined,
      input: (request, signal) => this.requestPrivateInput(request, signal) });
    this.executor = new HostSerialExecutor(new PermissionAwareExecutor(this.privileged, new BashAnalyzer(), Date.now,
      (operation, analysis, result, options) => {
        const scope = operation.scope;
        // Exit-0 evidence backfills tool readiness; dispatched mutations invalidate per fact type.
        this.environment.absorbCommandFacts(scope.hostId, scope.loginAs ?? scope.runAs, commandEnvironmentFacts(analysis,
          result, options, scope.loginAs ?? scope.runAs, Date.now()));
      }));
  }

  private post(message: RuntimeMessage): void {
    const diagnostic = eventDiagnostic(message);
    if (diagnostic) this.send({ diagnostic });
    this.send(message);
  }

  private invalidatePreparation(call: RuntimeCall): void {
    if ('taskId' in call && call.taskId && ['set-conversation-thinking', 'set-conversation-model', 'stop-operation',
      'update-conversation-review-mode', 'request-ai-denial-review', 'authorize-task', 'task-message', 'answer-clarification',
      'cancel-clarification', 'pause-task', 'resume-task', 'delete-task'].includes(call.method)) this.preparations.cancelTask(call.taskId);
    if (call.method === 'set-review-key') this.preparations.cancelAll();
    if (call.method === 'commit-operation-risk') this.preparations.cancelTask(call.operation.taskId);
    if (call.method === 'disconnect' || call.method === 'update-host-safety') {
      for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(call.hostId)) this.preparations.cancelTask(runner.task.id);
    }
    if ('terminalId' in call && ['close-terminal', 'stop-terminal', 'terminal-input'].includes(call.method)) {
      const taskId = this.terminal.taskOf(call.terminalId); if (taskId) this.preparations.cancelTask(taskId);
    }
  }

  async dispatch(call: RuntimeCall): Promise<unknown> {
    this.invalidatePreparation(call);
    switch (call.method) {
      case 'cancel-message': this.preparations.cancel(call.requestId); return;
      case 'prepare-message': return this.preparations.prepare(call, call.taskId ? this.tasks.get(call.taskId) : undefined);
      case 'restore-operations':
        this.executor.bindRiskDomains(call.riskBindings ?? []);
        return this.executor.restore(call.operations);
      case 'prepare-operation-risk':
        for (const runner of this.tasks.values()) runner.assertResolvableOutcome(call.operationId);
        if (!this.executor.canReconcile(call.hostId, call.operationId)) {
          throw new Error('原远端操作仍在运行，请等待其退出或停止后重试');
        }
        return;
      case 'commit-operation-risk': {
        assertCommittedRiskAcceptance(call.operation);
        if (!this.executor.reconcile(call.operation.hostId, call.operation.id)) throw new Error('远端进程尚未退出，无法解除写锁');
        // The durable acceptance already exists. A failed execution-status
        // notification must not turn this successful release into a rollback
        // of the authoritative record while the executor remains unlocked.
        for (const runner of this.tasks.values()) {
          try { runner.recordRiskAcceptance(call.operation); }
          catch { console.warn('Could not publish risk acceptance execution status'); }
        }
        return;
      }
      case 'has-task': return this.tasks.has(call.taskId);
      case 'set-review-key':
        for (const runner of this.tasks.values()) runner.setReviewKey(call.jevKey);
        return;
      case 'set-review-profile': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        if (runner.needsReviewProfile(call.reviewer)) {
          this.preparations.cancelTask(call.taskId);
          for (const [id, pending] of this.pendingApprovals) if (pending.taskId === call.taskId) this.cancelApproval(id, 'stale');
          runner.setReviewProfile(call.reviewer);
        }
        return;
      }
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
        this.connectionAttempts.get(call.hostId)?.abort();
        this.manualSessions.disconnect(call.hostId);
        for (const runner of this.tasks.values()) if (runner.task.hostIds.includes(call.hostId)) runner.pause();
        this.terminal.closeHost(call.hostId);
        this.ssh.disconnect(call.hostId);
        this.post({ event: { type: 'host-status', hostId: call.hostId, status: 'disconnected' } });
        return;
      case 'connect': return this.connect(call.host, call.jump, call.riskBindings);
      case 'test-host': return testHostConnection(call.host, call.jump);
      case 'update-host-safety':
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.hostId === call.hostId) this.cancelApproval(id, 'stale');
        }
        for (const runner of this.tasks.values()) runner.updateHostSafety(call.hostId, call.mode,
          call.protectedReadPaths, call.protectedWritePaths, call.revision);
        return;
      case 'update-conversation-review-mode': {
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.taskId === call.taskId && pending.hostId === call.hostId) this.cancelApproval(id, 'stale');
        }
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        runner.updateConversationReviewMode(call.hostId, call.mode, call.revision);
        return;
      }
      case 'request-ai-denial-review': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效');
        return runner.requestAiDenialReview(call.operationId);
      }
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
        this.bindHostRiskDomains(call.hosts);
        if (!call.task.session || call.task.session.id !== call.task.id || !call.sessionDirectory) throw new Error('Native session binding required');
        if (!call.restored) this.send({ diagnostic: safeDiagnostic({ event: 'chat', level: 'info', taskId: call.task.id, role: 'user', size: Buffer.byteLength(call.task.goal) }) });
        if (this.tasks.has(call.task.id)) throw new Error('Task is already active');
        const runner = new TaskRunner(call.task, call.hosts, call.profile, call.priorOperations ?? [], this.terminal, this.executor,
          (hostId, taskId, binding) => this.openTerminal(hostId, taskId, binding), {
            commitInput: (value) => {
              if (value.taskId !== call.task.id) throw new Error('Input conversation binding changed');
              return this.inputCommits.commit(value);
            },
            commitOperation: (operation) => {
              if (operation.taskId !== call.task.id) throw new Error('Operation conversation binding changed');
              return this.operationCommits.commit(operation);
            },
            budget: (command, signal) => {
              if (!('taskId' in command) || command.taskId !== call.task.id) throw new Error('Budget conversation binding changed');
              return this.budget.request(command, signal);
            },
            clearCredentials: () => this.commands.clearTask(call.task.id),
            diagnostic: (diagnostic) => this.send({ diagnostic: safeDiagnostic(diagnostic) }),
            event: (event) => this.post({ event } as RuntimeMessage),
            requestApproval: (view) => this.requestApproval(view),
            cancelApproval: (id) => this.cancelApproval(id)
          }, (operationId, cursor) => this.readLog(call.task.id, operationId, cursor), this.privileged.forTask(call.task.id),
          { id: call.task.session.id, directory: call.sessionDirectory, restore: !!call.restored }, {
            inspect: (operation, scriptPath) => this.ssh.inspectScript(operation.scope.hostId,
              path.posix.resolve(operation.scope.cwd, scriptPath)),
            verify: async (operation, scriptPath, sha256) => {
              const inspected = await this.ssh.inspectScript(operation.scope.hostId,
                path.posix.resolve(operation.scope.cwd, scriptPath));
              return inspected.sha256 === sha256;
            }
          }, this.environment, call.priorInputs, (hostId, filePath, cwd, signal, maxBytes = REMOTE_READ_LIMIT) => {
            const host = call.hosts.find((candidate) => candidate.id === hostId);
            if (!host) throw new Error('Host is outside this conversation');
            // Reads never bypass a user protection rule or the credential boundary.
            const target = resolveRemoteReadTarget(filePath, cwd);
            assertRemoteReadAllowed(target, host.protectedReadPaths ?? host.protectedPaths);
            return this.ssh.readFileForEdit(hostId, target, maxBytes, signal);
          });
        this.tasks.set(call.task.id, runner);
        const start = runner.start(call.restored, call.thinkingLevel, call.document, call.initialMessage, call.intent);
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
        this.bindHostRiskDomains(call.hosts);
        runner.addAuthorization(call.hosts, call.localScopes, call.prepared);
        return;
      }
      case 'answer-clarification':
      case 'cancel-clarification': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('对话运行已失效，请重新发送需求');
        if (call.method === 'answer-clarification') return runner.answerClarification(call.requestId, call.answers);
        return runner.cancelClarification(call.requestId);
      }
      case 'cancel-queued-input': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('Input queue unavailable; no conversation was restored');
        return runner.cancelQueuedInput(call.inputId);
      }
      case 'task-message': {
        const runner = this.tasks.get(call.taskId);
        if (!runner) throw new Error('请先恢复对话');
        if (call.document && this.deliveredMessages.has(call.document.requestId)) return;
        if (call.queueMode === undefined) await runner.message(call.text, call.document, call.intent, call.preparedRevision);
        else await runner.message(call.text, call.document, call.intent, call.preparedRevision, call.queueMode);
        if (call.document) this.deliveredMessages.add(call.document.requestId);
        return;
      }
      case 'decide-approval': {
        const pending = this.pendingApprovals.get(call.approvalId);
        if (!pending) throw new Error('Approval expired');
        if (Date.now() >= pending.expiresAt) {
          this.cancelApproval(call.approvalId, 'expired');
          throw new Error('Approval expired');
        }
        if (typeof call.approved !== 'boolean') throw new Error('Invalid approval decision');
        if (!this.settleApproval(call.approvalId, call.approved)) throw new Error('Approval channel unavailable');
        return;
      }
      case 'answer-input': {
        if (this.pendingInputs.has(call.requestId)) return this.answerInput(call.requestId, call.answer);
        if (!await this.interactions.answer(call.requestId, call.answer)) throw new Error('Input request expired');
        return;
      }
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

  resolveInputCommit(result: unknown): void { this.inputCommits.resolve(result); }

  resolveOperationCommit(result: unknown): void { this.operationCommits.resolve(result); }

  resolveBudget(result: unknown): void { this.budget.resolve(result); }

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

  private bindHostRiskDomains(hosts: RuntimeHost[]): void {
    const known = new Map([...this.hosts, ...hosts.map((host) => [host.id, host] as const)]);
    this.executor.bindRiskDomains(hosts.map((host) => ({ hostId: host.id,
      riskDomainId: host.riskDomainId ?? resolveHostRiskDomain(host, (id) => known.get(id)) })));
  }

  private async connect(host: RuntimeHost, jump?: RuntimeHost,
    riskBindings?: Array<{ hostId: string; riskDomainId: string }>): Promise<void> {
    if (this.connectionAttempts.has(host.id)) throw new Error('SSH connection is already in progress');
    // The main process owns the full host graph; its bindings resolve lineages through
    // records the worker has never seen. The local fallback only serves callers that
    // cannot provide the authoritative bindings yet.
    if (riskBindings !== undefined) this.executor.bindRiskDomains(riskBindings);
    else this.bindHostRiskDomains(jump ? [jump, host] : [host]);
    const connectionId = randomUUID(), controller = new AbortController();
    this.connectionAttempts.set(host.id, controller);
    this.hosts.set(host.id, host);
    if (jump) this.hosts.set(jump.id, jump);
    try {
      await this.ssh.connect(host as SshHost, runtimeSshCredentials(host),
        jump ? { host: jump as SshHost, secret: runtimeSshCredentials(jump) } : undefined,
        (prompt) => this.requestLoginInput(connectionId, prompt.hostId === jump?.id ? jump : host, prompt, controller.signal), controller.signal, { onDemandAuthentication: true });
      controller.signal.throwIfAborted();
      const observation = await this.environment.refresh(host.id, host.username, controller.signal);
      controller.signal.throwIfAborted();
      if (host.fingerprint && observation.status === 'observed' && observation.data
        && observation.connectionId && observation.observedAt !== null) this.post({ event: {
        type: 'host-capability-observed', value: { version: 1, hostId: host.id, hostFingerprint: host.fingerprint,
          loginAs: host.username, connectionId: observation.connectionId,
          observedAt: observation.observedAt, data: observation.data }
      } });
      this.post({ event: { type: 'host-status', hostId: host.id, status: 'connected' } });
    } catch (error) {
      this.post({ event: { type: 'host-status', hostId: host.id, status: controller.signal.aborted ? 'disconnected' : error instanceof HostKeyError ? 'changed-key' : 'error' } });
      if (controller.signal.aborted) throw new Error('SSH 连接已取消');
      throw error;
    } finally {
      controller.abort();
      if (this.connectionAttempts.get(host.id) === controller) this.connectionAttempts.delete(host.id);
    }
  }

  private requestLoginInput(connectionId: string, host: RuntimeHost, prompt: SshLoginPrompt, signal: AbortSignal): Promise<string | null> {
    if (prompt.hostId !== host.id || prompt.username !== host.username) return Promise.resolve(null);
    const kind = /otp|one.time|verification|验证码|动态码|令牌/u.test(prompt.text.toLowerCase()) ? 'otp'
      : prompt.echo ? 'text' : 'secret';
    const request: Omit<InputRequestView, 'id' | 'expiresAt'> = {
      taskId: '', operationId: `ssh-login:${connectionId}`, hostId: host.id,
      title: kind === 'otp' ? 'SSH 登录需要验证码' : kind === 'secret' ? 'SSH 登录需要身份验证' : 'SSH 登录需要输入',
      explanation: `正在连接 ${host.label}（${host.address}）并登录账户 ${prompt.username}。服务器通过 SSH 登录认证请求这项信息，回答仅发送给本次认证会话，AI 不会看到。服务器提示：${prompt.text.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300)}`,
      kind
    };
    return this.requestPrivateInput(request, signal);
  }

  private answerInput(id: string, answer: string | null): void {
    const pending = this.pendingInputs.get(id);
    if (!pending) throw new Error('Input request expired');
    this.pendingInputs.delete(id);
    clearTimeout(pending.timeout);
    this.post({ event: { type: 'input-close', id } });
    const current = Date.now() < pending.expiresAt;
    pending.resolve(current ? answer : null);
    if (!current && answer !== null) throw new Error('Input request expired');
  }

  private async openTerminal(hostId: string, taskId?: string, binding?: import('@cloudhelm/core').ExecutionTerminalBinding): Promise<string> {
    const assertBinding = () => {
      if (binding && (binding.hostId !== hostId || !this.ssh.matchesConnection(hostId, binding.loginAs, binding.connectionId)))
        throw new Error('SSH 登录身份或连接代次已变化，终端未建立');
    };
    assertBinding();
    const probe = taskId ? await this.ssh.execFixed(hostId, 'pwd -P') : undefined;
    if (probe && (probe.exitCode !== 0 || !probe.output.trim().startsWith('/') || probe.output.trim().includes('\n'))) throw new Error('无法核验 Agent 登录目录');
    assertBinding();
    if (taskId) return this.terminal.open(hostId, new SshCommandTerminal(this.ssh, hostId), taskId, probe!.output.trim());
    const host = this.hosts.get(hostId);
    if (!host) throw new Error('Host is not connected');
    const decoder = createTerminalCodec(host.connection?.terminal?.encoding);
    const grant = await this.manualSessions.authorize(host);
    const options = { settings: grant.settings, signal: grant.signal, assertAuthorized: grant.assertCurrent, x11Cookie: runtimeSshCredentials(host).x11Cookie };
    const { channel, nonce } = await this.ssh.integratedShell(hostId, 100, 30, options).catch((error: unknown) => { grant.close(); throw error; });
    if (channel.destroyed || channel.readableEnded) { grant.close(); channel.close(); throw new Error('人工终端启动后即结束，请检查初始化命令'); }
    channel.once('close', grant.close);
    let output = (_text: string) => {};
    let command = (_event: Parameters<NonNullable<RawTerminal['onCommand']>>[0] extends (event: infer E) => void ? E : never) => {};
    let cwd = (_directory: string) => {};
    const parser = new ShellMarkerParser(nonce, (text) => output(text), (event) => command(event), (directory) => cwd(directory), decoder.decode);
    const raw: RawTerminal = {
      write: (data) => channel.write(decoder.encode(data)),
      resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
      close: () => channel.end(),
      onCwd: (listener) => { cwd = listener; },
      onCommand: (listener) => { command = listener; },
      onData: (listener) => { output = listener; channel.on('data', (data: Buffer) => parser.push(decoder.write(data))); },
      onClose: (listener) => { channel.on('close', () => { parser.push(decoder.end()); parser.finish(); listener(); }); }
    };
    const terminalId = this.terminal.open(hostId, raw, undefined, '/');
    try {
      const stopKeepalive = this.ssh.startManualKeepalive(hostId, options,
        () => !this.executor.hasPendingOrUnresolved(hostId) && ![...this.tasks.values()].some((runner) => runner.task.hostIds.includes(hostId) && !runner.canDelete),
        (message) => output(`\r\n[CloudHelm] ${message}\r\n`));
      channel.once('close', stopKeepalive);
    } catch (error) { grant.close(); channel.close(); throw error; }
    return terminalId;
  }

  private requestApproval(view: ApprovalView): Promise<boolean> {
    if (!Number.isSafeInteger(view.expiresAt)) return Promise.reject(new Error('Invalid approval deadline'));
    if (view.expiresAt <= Date.now()) return Promise.reject(new ApprovalInterruptedError('expired'));
    if (this.pendingApprovals.has(view.id)) return Promise.reject(new Error('Approval already pending'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.cancelApproval(view.id, 'expired'), view.expiresAt - Date.now());
      const pending = { taskId: view.taskId, hostId: view.hostId, expiresAt: view.expiresAt,
        resolve: (allowed: boolean) => { clearTimeout(timeout); queueMicrotask(() => resolve(allowed)); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); } };
      // Register before publishing: even an immediate reply must bind this recipient.
      this.pendingApprovals.set(view.id, pending);
      try { this.post({ event: { type: 'approval-open', value: view } }); }
      catch {
        this.pendingApprovals.delete(view.id);
        pending.reject(new Error('Approval channel unavailable'));
      }
    });
  }

  private settleApproval(id: string, value: boolean | ApprovalInterruptedError): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    this.pendingApprovals.delete(id);
    try { this.post({ event: { type: 'approval-close', id } }); }
    catch { pending.reject(new Error('Approval channel unavailable')); return false; }
    if (value instanceof ApprovalInterruptedError) pending.reject(value);
    else pending.resolve(value);
    return true;
  }

  private cancelApproval(id: string, outcome: ApprovalInterruption = 'canceled'): void {
    this.settleApproval(id, new ApprovalInterruptedError(outcome));
  }

}
