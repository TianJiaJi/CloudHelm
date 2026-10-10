import { randomUUID } from 'node:crypto';
import { PrivilegedSessions, type SafetyGate, type TerminalManager } from '@cloudhelm/application';
import { SshCommandTerminal, SshTransport, SuSession } from '@cloudhelm/adapters';
import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation, RawTerminal } from '@cloudhelm/core';
import type { InputRequestView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { PrivilegedTaskAccess } from './privileged-access.js';
import { FileOperationExecutor } from './file-operation-executor.js';

class DeferredTerminal implements RawTerminal {
  target?: RawTerminal;
  private data = (_value: string) => {};
  private display = (_value: string) => {};
  private failure = (_failure: Pick<OperationResult, 'failureKind' | 'effects'>) => {};
  private exit = (_value: number | undefined) => {};
  private closed = () => {};
  private ended = false;
  constructor(private readonly revoke: () => void) {}
  attach(target: RawTerminal): void {
    if (this.ended) { target.close(); throw new Error('Root terminal closed'); }
    this.target = target; target.onData(this.data); target.onDisplay?.(this.display);
    target.onExecutionFailure?.(this.failure); target.onExit?.(this.exit); target.onClose(() => this.finishClose());
  }
  onData(listener: (value: string) => void): void { this.data = listener; }
  onDisplay(listener: (value: string) => void): void { this.display = listener; }
  onExecutionFailure(listener: typeof this.failure): void { this.failure = listener; }
  onExit(listener: (value: number | undefined) => void): void { this.exit = listener; }
  onClose(listener: () => void): void { this.closed = listener; }
  execute(command: string, cwd: string, current: () => boolean): Promise<void> {
    if (!this.target?.execute) throw new Error('Root session not authenticated');
    return this.target.execute(command, cwd, current);
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
  id: string; taskId: string; host: RuntimeHost; mode: 'ssh' | 'su'; terminalId: string;
  raw: DeferredTerminal; controller: AbortController; sourceGeneration: number;
  ssh?: SshTransport; su?: SuSession; executor?: OperationExecutor; probeId: string;
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

  forTask(taskId: string): PrivilegedTaskAccess {
    return {
      request: (host, command, cwd, reason, goal, gate, signal) => this.request(taskId, host, command, cwd, reason, goal, gate, signal),
      terminal: (id, hostId) => { this.grants.get(id, taskId, hostId); return this.entries.get(id)!.terminalId; },
      scope: (terminalId) => {
        const entry = [...this.entries.values()].find((e) => e.taskId === taskId && e.terminalId === terminalId);
        if (!entry) return {};
        this.grants.get(entry.id, taskId, entry.host.id, true);
        return { sessionId: entry.id, loginAs: entry.mode === 'ssh' ? 'root' : entry.host.username, runAs: 'root', connectionGeneration: 1 };
      },
      owns: (terminalId) => [...this.entries.values()].some((e) => e.taskId === taskId && e.terminalId === terminalId),
      close: () => this.closeTask(taskId)
    };
  }

  private async request(taskId: string, host: RuntimeHost, command: string, cwd: string, reason: string, goal: string,
    gate: SafetyGate, signal?: AbortSignal): Promise<{ sessionId: string; method: 'ssh' | 'su'; runAs: 'root' }> {
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
        title: '确认使用 root 身份', choices: ['SSH 登录 root', '通过 su 切换 root'],
        explanation: `主机：${host.label}（${host.address}:${host.port}）\n原因：${reason}\n目录：${cwd}\n待执行操作：${command}\n确认仅建立本轮受控会话，后续操作仍逐条审核。` }, controller.signal);
      controller.signal.throwIfAborted();
      if (choice !== 'SSH 登录 root' && choice !== '通过 su 切换 root') throw new Error('Root session canceled');
      if (sourceGeneration !== this.deps.ssh.connectionGeneration(host.id)) throw new Error('SSH connection changed during confirmation');
      const grant = this.grants.begin(taskId, host.id, choice === 'SSH 登录 root' ? 'ssh' : 'su');
      const raw = new DeferredTerminal(() => this.close(grant.id));
      const terminalId = this.deps.terminal.open(host.id, raw, taskId, cwd);
      entry = { id: grant.id, taskId, host, mode: grant.mode, raw, terminalId, controller: grant.controller, sourceGeneration, probeId };
      this.entries.set(entry.id, entry);
      const stop = () => this.close(grant.id);
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        const outcome = await gate.execute({ id: probeId, kind: 'command', command: 'id -u', scope: {
          taskId, hostId: host.id, terminalId, terminalGeneration: this.deps.terminal.currentGeneration(terminalId),
          cwd, runAs: 'root', loginAs: entry.mode === 'ssh' ? 'root' : host.username, sessionId: entry.id, connectionGeneration: 1,
          policyRevision: host.policyRevision, allowedWorkingRoots: ['/'], protectedPaths: [...host.protectedPaths],
          protectedReadPaths: [...(host.protectedReadPaths ?? host.protectedPaths)],
          protectedWritePaths: [...(host.protectedWritePaths ?? host.protectedPaths)], goal
        } }, controller.signal);
        if (outcome.result?.status !== 'succeeded' || outcome.result.stdoutTail.trim() !== '0') throw new Error('Root identity could not be verified; session closed');
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

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    if (!operation.scope.sessionId) return this.deps.ordinary.execute(operation, fingerprint, signal, options);
    const entry = this.entries.get(operation.scope.sessionId);
    const current = () => {
      if (!entry || entry.controller.signal.aborted || signal?.aborted || options?.isAuthorized?.() === false
        || entry.sourceGeneration !== this.deps.ssh.connectionGeneration(entry.host.id)
        || operation.scope.terminalId !== entry.terminalId || operation.scope.runAs !== 'root'
        || operation.scope.connectionGeneration !== 1) throw new Error('Root operation authorization expired');
      this.grants.get(entry.id, operation.scope.taskId, operation.scope.hostId, operation.id === entry.probeId);
    };
    current();
    const active = entry!;
    if (!active.executor) {
      if (operation.id !== active.probeId || operation.kind !== 'command' || operation.command !== 'id -u') throw new Error('Root setup must verify identity first');
      try { await this.authenticate(active, current); }
      catch {
        this.close(active.id);
        return { operationId: operation.id, status: 'failed', failureKind: 'authentication-failed', effects: 'none', requiresUserAction: true,
          stdoutTail: 'Root authentication failed, canceled, or unsupported. No business command was sent. Explicit user continuation is required.' };
      }
    }
    current();
    return active.executor!.execute(operation, fingerprint, signal, options);
  }

  private async authenticate(entry: Entry, current: () => void): Promise<void> {
    const input = (title: string, explanation: string, kind: InputRequestView['kind'] = 'secret') => this.deps.input({
      taskId: entry.taskId, hostId: entry.host.id, operationId: entry.probeId, title, explanation, kind
    }, entry.controller.signal);
    let transport: SshTransport | SuSession;
    if (entry.mode === 'ssh') {
      const ssh = new SshTransport(() => this.close(entry.id)); entry.ssh = ssh;
      const host = { ...entry.host, username: 'root', secret: undefined };
      // Existing key/agent selection may be used, but never reuse the login account's saved password.
      let secret: string | null = null;
      if (host.auth === 'password') secret = await input('root SSH 密码', `接收方：${host.address}:${host.port} 的 root SSH 认证。本次不保存凭据。`);
      if (host.auth === 'private-key') {
        const choice = await this.deps.input({ taskId: entry.taskId, hostId: host.id, operationId: entry.probeId,
          kind: 'confirmation', title: 'root SSH 私钥口令', explanation: '使用此主机已选择的私钥文件，以 root 身份认证。',
          choices: ['私钥无口令', '输入私钥口令'] }, entry.controller.signal);
        if (choice === '私钥无口令') secret = '';
        else if (choice === '输入私钥口令') secret = await input('root SSH 私钥口令', '口令仅交给本次 SSH 认证，不保存。');
        else throw new Error('Root login canceled');
      }
      if (host.auth !== 'agent' && secret === null) throw new Error('Root login canceled');
      current();
      const jump = this.deps.jump(host);
      await ssh.connect(host, { password: secret ?? undefined, passphrase: secret ?? undefined },
        jump ? { host: jump, secret: { password: jump.secret, passphrase: jump.secret } } : undefined,
        (challenge) => {
          const recipient = challenge.hostId === host.id ? host : jump;
          if (!recipient || recipient.id !== challenge.hostId || recipient.username !== challenge.username) return Promise.resolve(null);
          return this.deps.input({ taskId: entry.taskId, hostId: recipient.id, operationId: entry.probeId,
            title: 'SSH 追加认证', explanation: `接收方：${recipient.address}:${recipient.port} 的 ${challenge.username} SSH 认证。`,
            kind: /otp|verification|one.time/iu.test(challenge.text) ? 'otp' : 'secret' }, entry.controller.signal);
        }, entry.controller.signal);
      transport = ssh;
      entry.executor = new FileOperationExecutor(this.deps.terminal, ssh, this.deps.terminal);
    } else {
      const su = new SuSession(this.deps.ssh, entry.host.id, entry.controller.signal, () => this.close(entry.id)); entry.su = su;
      await su.connect(() => input('su root 身份验证', `接收方：${entry.host.label} 上本次操作的 su 认证进程。密码不会发送给业务命令。`), current);
      transport = su;
      entry.executor = { execute: (operation, fingerprint, signal, options) => operation.kind === 'command'
        ? this.deps.terminal.execute(operation, fingerprint, signal, options)
        : Promise.resolve({ operationId: operation.id, status: 'failed', failureKind: 'unsupported', effects: 'none',
          stdoutTail: 'su does not elevate SFTP. Stage nonsecret content with the ordinary account, then use a separately reviewed root install command.' }) };
    }
    current();
    entry.raw.attach(new SshCommandTerminal(transport, entry.host.id));
  }

  private close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); this.grants.close(id);
    if (this.deps.terminal.hostOf(entry.terminalId)) this.deps.terminal.close(entry.terminalId);
    entry.su?.close(); entry.ssh?.close();
  }
  private closeTask(taskId: string): void {
    this.requesting.get(taskId)?.abort();
    for (const entry of this.entries.values()) if (entry.taskId === taskId) this.close(entry.id);
    this.grants.closeTask(taskId);
  }
}
