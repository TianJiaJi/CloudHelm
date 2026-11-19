import { randomUUID } from 'node:crypto';
import { PrivilegedSessions, type SafetyGate, type TerminalManager } from '@cloudhelm/application';
import { BashAnalyzer, SshAuthenticationError, SshCommandTerminal, SshTransport } from '@cloudhelm/adapters';
import { PrivilegeError, sudoContextCommand, type PrivilegeMethod } from '@cloudhelm/core';
import type { ExecutionOptions, OperationExecutor, OperationResult, OperationIntent, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import type { InputRequestView } from '@cloudhelm/contracts';
import { runtimeSshCredentials } from '@cloudhelm/contracts/runtime';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { FileOperationExecutor } from './file-operation-executor.js';

class DeferredTerminal implements RawTerminal {
  target?: RawTerminal;
  private data = (_value: string) => {};
  private display = (_value: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege' | 'requiresUserAction'>) => {};
  private exit = (_value: number | undefined) => {};
  private started = (_event: { pid: number }) => {};
  private authentication = (_value: { id: string; prompt?: string }) => {};
  private closed = () => {};
  private ended = false;
  constructor(private readonly revoke: () => void) {}
  attach(target: RawTerminal): void {
    if (this.ended) { target.close(); throw new Error('Root terminal closed'); }
    this.target = target; target.onData(this.data); target.onDisplay?.(this.display);
    target.onProcessStarted?.(this.started);
    target.onExecutionFailure?.(this.failure); target.onExit?.(this.exit); target.onAuthentication?.(this.authentication); target.onClose(() => this.finishClose());
  }
  onData(listener: (value: string) => void): void { this.data = listener; }
  onDisplay(listener: (value: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (value: number | undefined) => void): void { this.exit = listener; }
  onProcessStarted(listener: typeof this.started): void { this.started = listener; this.target?.onProcessStarted?.(listener); }
  onAuthentication(listener: typeof this.authentication): void { this.authentication = listener; this.target?.onAuthentication?.(listener); }
  interrupt(pid: number): Promise<'sent' | 'already-exited'> {
    return this.target?.interrupt?.(pid) ?? Promise.reject(new Error('Root process control unavailable'));
  }
  answerAuthentication(id: string, answer: string | null): boolean { return this.target?.answerAuthentication?.(id, answer) ?? false; }
  onClose(listener: () => void): void { this.closed = listener; }
  execute(command: string, cwd: string, current: () => boolean, options?: { sudoAuthorization?: boolean }): Promise<void> {
    if (!this.target?.execute) throw new Error('Root session not authenticated');
    return this.target.execute(command, cwd, current, options);
  }
  write(value: string): void { this.target?.write(value); }
  resize(cols: number, rows: number): void { this.target?.resize(cols, rows); }
  takeOver(): void { queueMicrotask(this.revoke); }
  close(): void { this.target?.close(); this.finishClose(); }
  private finishClose(): void {
    if (this.ended) return;
    this.ended = true; this.closed(); this.revoke();
  }
}
interface Entry {
  id: string; taskId: string; host: RuntimeHost; mode: PrivilegeMethod; terminalId: string;
  raw: DeferredTerminal; controller: AbortController; sourceGeneration: number;
  ssh?: SshTransport; executor?: OperationExecutor; probeId: string;
}
interface Dependencies {
  terminal: TerminalManager; ssh: SshTransport; ordinary: OperationExecutor;
  jump(host: RuntimeHost): RuntimeHost | undefined;
  input(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null>;
}

/** Desktop assembly routes application-owned grants to isolated adapter transports. */
export class PrivilegedRuntime implements OperationExecutor {
  private readonly grants = new PrivilegedSessions();
  private readonly entries = new Map<string, Entry>();
  private readonly requesting = new Map<string, AbortController>();
  constructor(private readonly deps: Dependencies) {}
  get supportsFileTransactions(): boolean { return this.deps.ordinary.supportsFileTransactions === true; }

  forTask(taskId: string): PrivilegedTaskAccess {
    return {
      request: (host, command, cwd, reason, goal, gate, signal, intent, method) => this.request(taskId, host, command, cwd, reason, goal, gate, signal, intent, method),
      prepare: async (operation) => { if (operation.scope.taskId !== taskId) throw new Error('Context outside task'); return this.prepare(operation); },
      sudoContexts: () => [...this.entries.values()].flatMap((entry) => {
        try {
          if (entry.mode !== 'sudo' || entry.taskId !== taskId) return [];
          this.grants.get(entry.id, taskId, entry.host.id);
          if (!this.deps.terminal.isAgentOwner(entry.terminalId) || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)) return [];
          return [{ sessionId: entry.id, hostId: entry.host.id, state: 'prepared' as const, loginAs: entry.host.username, targetRunAs: 'root' as const }];
        } catch { return []; }
      }),
      terminal: (id, hostId) => { this.grants.get(id, taskId, hostId); return this.entries.get(id)!.terminalId; },
      scope: (terminalId) => {
        const entry = [...this.entries.values()].find((e) => e.taskId === taskId && e.terminalId === terminalId);
        if (!entry) return {};
        this.grants.get(entry.id, taskId, entry.host.id, true);
        return { sessionId: entry.id, loginAs: entry.mode === 'ssh' ? 'root' : entry.host.username, runAs: 'root', connectionGeneration: 1 };
      },
      owns: (terminalId) => [...this.entries.values()].some((e) => e.taskId === taskId && e.terminalId === terminalId),
      confirmed: () => [...this.entries.values()].flatMap((entry) => {
        try {
          if (entry.mode === 'sudo') return [];
          this.grants.get(entry.id, taskId, entry.host.id);
          if (!this.deps.terminal.isAgentOwner(entry.terminalId)
            || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)) return [];
          return [{ sessionId: entry.id, hostId: entry.host.id, method: entry.mode, runAs: 'root' as const }];
        } catch { return []; } // Projection never grants/revives a session on inspection failure.
      }),
      close: () => this.closeTask(taskId)
    };
  }

  private async request(taskId: string, host: RuntimeHost, command: string, cwd: string, reason: string, goal: string,
    gate: SafetyGate, signal?: AbortSignal, intent?: OperationIntent, method: PrivilegeMethod = 'sudo'): ReturnType<PrivilegedTaskAccess['request']> {
    if (this.requesting.has(taskId)) throw new Error('Root session request already pending');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.requesting.set(taskId, controller);
    let entry: Entry | undefined;
    try {
      signal?.throwIfAborted();
      const probeId = randomUUID();
      const sourceGeneration = this.deps.ssh.connectionGeneration(host.id);
      const choice = await this.deps.input({ taskId, hostId: host.id, operationId: probeId, kind: 'confirmation',
        title: '确认提权方式（默认 sudo）', choices: method === 'ssh' ? ['SSH 登录 root'] : method === 'su' ? ['通过 su 切换 root'] : ['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'],
        explanation: method === 'su'
          ? `主机：${host.label}（${host.address}:${host.port}）\n原因：${reason}\n目录：${cwd}\n待执行操作：${command}\n通过 su 逐条提权：不创建通用 root Shell；每条操作独立审核、独立认证，root 密码仅进入该次操作的受控标记窗口。直接 su 通常需要 root 密码，不是登录用户的 sudo 密码。不知道 root 密码请取消。`
          : `主机：${host.label}（${host.address}:${host.port}）\n原因：${reason}\n目录：${cwd}\n待执行操作：${command}\n默认 sudo 逐条提权，不创建通用 root Shell，不执行上述操作或探测权限。root SSH须服务器允许；直接su通常需要root密码，不是登录用户的sudo密码。不知道root密码请选择sudo或取消。所有后续操作仍逐条审核。` }, controller.signal);
      controller.signal.throwIfAborted();
      if (!['使用 sudo（推荐）', 'SSH 登录 root', '通过 su 切换 root'].includes(choice ?? '')) throw new PrivilegeError({ method, stage: 'preparation', code: 'cancelled', source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
      if ((method === 'ssh' && choice !== 'SSH 登录 root') || (method === 'su' && choice !== '通过 su 切换 root')) throw new Error('Unconfirmed privilege method');
      if (sourceGeneration !== this.deps.ssh.connectionGeneration(host.id)) throw new Error('SSH connection changed during confirmation');
      if (method === 'su') {
        // Confirmation-only: the su route is stateless. Each operation is wrapped,
        // separately reviewed, and dispatched on the credential-bound native PTY;
        // no session, grant, or terminal is created here.
        return { method: 'su', runAs: 'root' };
      }
      const grant = this.grants.begin(taskId, host.id, choice === '使用 sudo（推荐）' ? 'sudo' : choice === 'SSH 登录 root' ? 'ssh' : 'su');
      const raw = new DeferredTerminal(() => this.close(grant.id));
      const terminalId = this.deps.terminal.open(host.id, raw, taskId, cwd);
      entry = { id: grant.id, taskId, host, mode: grant.mode, raw, terminalId, controller: grant.controller, sourceGeneration, probeId };
      this.entries.set(entry.id, entry);
      if (entry.mode === 'sudo') {
        entry.executor = this.deps.ordinary;
        raw.attach(new SshCommandTerminal(this.deps.ssh, host.id));
        controller.signal.throwIfAborted();
        return { sessionId: entry.id, method: 'sudo', state: 'prepared', loginAs: host.username, targetRunAs: 'root', identityVerified: false };
      }
      const stop = () => this.close(grant.id);
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        const outcome = await gate.execute({ id: probeId, kind: 'command', command: 'id -u', scope: {
          taskId, hostId: host.id, terminalId, terminalGeneration: this.deps.terminal.currentGeneration(terminalId),
          cwd, runAs: 'root', loginAs: entry.mode === 'ssh' ? 'root' : host.username, sessionId: entry.id, connectionGeneration: 1,
          policyRevision: host.policyRevision, allowedWorkingRoots: ['/'], protectedPaths: [...host.protectedPaths],
          protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
          protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal, intent
        } }, controller.signal);
        if (outcome.result?.status !== 'succeeded' || outcome.result.stdoutTail.trim() !== '0') {
          if (outcome.result?.privilege) throw new PrivilegeError(outcome.result.privilege);
          throw new Error('Root identity could not be verified; session closed');
        }
        this.grants.activate(entry.id, taskId, host.id);
        return { sessionId: entry.id, method: entry.mode, runAs: 'root' };
      } finally { controller.signal.removeEventListener('abort', stop); }
    } catch (error) {
      if (entry) this.close(entry.id);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.requesting.get(taskId) === controller) this.requesting.delete(taskId);
    }
  }

  private async prepare(operation: ProposedOperation): Promise<ProposedOperation> {
    if (!operation.scope.sessionId) return operation;
    const entry = this.entries.get(operation.scope.sessionId);
    const check = () => {
      if (!entry || entry.controller.signal.aborted || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)
        || entry.terminalId !== operation.scope.terminalId || !this.deps.terminal.isAgentOwner(entry.terminalId)) throw new Error('Privilege context expired');
      this.grants.get(entry.id, operation.scope.taskId, operation.scope.hostId);
    };
    check();
    if (entry!.mode !== 'ssh' && operation.kind !== 'command') throw new Error('sudo/su do not elevate SFTP; no file operation sent. Use the operation-level controlled file transaction; never stage/install to bypass metadata checks.');
    if (entry!.mode !== 'sudo' || operation.kind !== 'command') return operation;
    const command = sudoContextCommand(await new BashAnalyzer().analyze(operation.command));
    check();
    return { ...operation, command, scope: { ...operation.scope, loginAs: entry!.host.username, runAs: 'root' } };
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (!operation.scope.sessionId) return this.deps.ordinary.execute(operation, fingerprint, signal, options);
    const entry = this.entries.get(operation.scope.sessionId);
    const current = () => {
      if (!entry || entry.controller.signal.aborted || signal?.aborted || options?.isAuthorized?.() === false
        || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)
        || operation.scope.terminalId !== entry.terminalId || operation.scope.runAs !== 'root'
        || operation.scope.loginAs !== (entry.mode === 'ssh' ? 'root' : entry.host.username) || operation.scope.connectionGeneration !== 1) throw new Error('Root operation authorization expired');
      this.grants.get(entry.id, operation.scope.taskId, operation.scope.hostId, operation.id === entry.probeId);
    };
    current();
    const active = entry!;
    if (active.mode === 'sudo') {
      if (operation.kind !== 'command') return { operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
        stdoutTail: 'sudo contexts do not elevate SFTP. Use the operation-level controlled file transaction, not staging or identity fallback.' };
      try {
        if (sudoContextCommand(await new BashAnalyzer().analyze(operation.command)) !== operation.command) throw new Error('Unprepared');
      } catch { return { operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
        stdoutTail: 'Unprepared sudo operation refused before dispatch. Submit a supported literal command through the normal tool preparation and review.' }; }
      current();
    }
    if (!active.executor) {
      if (operation.id !== active.probeId || operation.kind !== 'command' || operation.command !== 'id -u') throw new Error('Root setup must verify identity first');
      try { await this.authenticate(active, current); }
      catch (error) {
        const privilege = error instanceof PrivilegeError ? error.feedback : { method: active.mode, stage: 'authentication' as const,
          code: 'authentication-unconfirmed' as const, source: 'transport' as const, businessCommand: 'not-started' as const, recovery: 'user-action' as const };
        this.close(active.id);
        return { operationId: operation.id, status: 'failed', failureKind: 'authentication-failed', effects: 'none', requiresUserAction: true, privilege,
          stdoutTail: 'Root identity was not established. No business command was sent. Explicit user continuation is required.' };
      }
    }
    current();
    return active.executor!.execute(operation, fingerprint, signal, options);
  }

  private async authenticate(entry: Entry, current: () => void): Promise<void> {
    if (entry.mode !== 'ssh') throw new Error('Only SSH sessions authenticate interactively');
    const ssh = new SshTransport(() => this.close(entry.id)); entry.ssh = ssh;
    const host = { ...entry.host, username: 'root', secret: undefined, credentials: undefined };
    // The transport negotiates first. Never reuse the ordinary account's password,
    // or prompt merely because this host was configured for password/private-key login.
    current();
    const jump = host.connection?.proxy?.enabled ? undefined : this.deps.jump(host);
    const proxyPassword = runtimeSshCredentials(entry.host).proxyPassword;
    try { await ssh.connect(host, proxyPassword === undefined ? {} : { proxyPassword },
      jump ? { host: jump, secret: runtimeSshCredentials(jump) } : undefined,
      async (challenge) => {
        current();
        const recipient = challenge.hostId === host.id ? host : jump;
        if (!recipient || recipient.id !== challenge.hostId || recipient.username !== challenge.username) return null;
        const answer = await this.deps.input({ taskId: entry.taskId, hostId: recipient.id, operationId: entry.probeId,
          title: challenge.kind === 'key-passphrase' ? 'SSH 加密私钥口令' : 'SSH 身份验证',
          explanation: `接收方：${recipient.address}:${recipient.port} 的 ${challenge.username} SSH 认证（${challenge.attempt ?? 1}/3）。仅用于本次认证，不保存。`,
          kind: /otp|verification|one.time/iu.test(challenge.text) ? 'otp' : 'secret' }, entry.controller.signal);
        current(); return answer;
      }, entry.controller.signal, { onDemandAuthentication: true }); }
    catch (error) {
      if (error instanceof PrivilegeError) throw error;
      const rejected = error && typeof error === 'object' && 'level' in error && error.level === 'client-authentication';
      throw new PrivilegeError({ method: 'ssh', stage: 'authentication', code: error instanceof SshAuthenticationError ? error.code : rejected ? 'authentication-rejected' : 'authentication-unconfirmed',
        source: 'transport', businessCommand: 'not-started', recovery: 'user-action' });
    }
    const transport = ssh;
    entry.executor = new FileOperationExecutor(this.deps.terminal, ssh, this.deps.terminal);
    current();
    entry.raw.attach(new SshCommandTerminal(transport, entry.host.id));
  }

  private close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); this.grants.close(id);
    if (this.deps.terminal.hostOf(entry.terminalId)) this.deps.terminal.close(entry.terminalId);
    entry.ssh?.close();
  }
  private closeTask(taskId: string): void {
    this.requesting.get(taskId)?.abort();
    for (const entry of this.entries.values()) if (entry.taskId === taskId) this.close(entry.id);
    this.grants.closeTask(taskId);
  }
}
