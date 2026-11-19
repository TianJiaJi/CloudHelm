import type { InputRequestView } from '@cloudhelm/contracts';

export interface SudoSessionCredentialDeps {
  input(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null>;
}

export interface SudoSessionCredentialContext {
  taskId: string;
  hostId: string;
  hostLabel: string;
  sessionId: string;
  /** The exact reviewed command this credential will dispatch; shown to bind
   * the request to one concrete operation, never used as command input. */
  command: string;
  /** Aborts the confirmation when the session closes or the task stops. */
  signal: AbortSignal;
}

/** Runtime-only sudo session credential. The secret lives in exactly one
 * zero-filled buffer behind a TTL; it is never persisted, logged, echoed into
 * command text, or handed to anything but the session's stdin injection
 * channel. A rejected password drops the buffer so the next dispatch asks the
 * user again instead of replaying a known-bad secret. */
export class SudoSessionCredentials {
  private secret?: Buffer;
  private expiresAt = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: SudoSessionCredentialDeps, private readonly ttlMs = 15 * 60_000) {}

  /** Resolve the password from the cache or one bound user confirmation.
   * Returns undefined when the user declined, the request expired, or the
   * answer cannot travel the injection channel; the caller must then not
   * dispatch. */
  async obtain(context: SudoSessionCredentialContext): Promise<string | undefined> {
    if (this.secret && this.expiresAt > Date.now()) return this.secret.toString('utf8');
    this.drop();
    const command = context.command.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 160);
    const answer = await this.deps.input({
      taskId: context.taskId, hostId: context.hostId, operationId: `sudo-session:${context.sessionId}`,
      kind: 'secret', title: 'sudo 会话需要密码',
      explanation: `接收方：主机 ${context.hostLabel} 的 sudo 认证进程（专用 stdin 注入通道）。本次派发命令：${command || '（见审核卡片）'}。`
        + `确认一次后仅在本会话内存中复用 ${Math.round(this.ttlMs / 60_000)} 分钟；不写入磁盘、命令文本、AI 上下文或日志；`
        + `会话结束、断线、任务停止或密码被拒即清除。通常为登录账户密码，特殊 sudo/PAM 策略可能不同。`
    }, context.signal);
    if (answer === null || answer === '' || answer.length > 4095 || /[\r\n\u0000]/u.test(answer)) {
      this.drop();
      return undefined;
    }
    this.secret = Buffer.from(answer, 'utf8');
    this.expiresAt = Date.now() + this.ttlMs;
    this.timer = setTimeout(() => this.drop(), this.ttlMs);
    this.timer.unref?.();
    return this.secret.toString('utf8');
  }

  /** sudo rejected the injected password or confirmation was abandoned. */
  reject(): void { this.drop(); }

  /** The session ended (close, disconnect, task stop, process exit). */
  close(): void { this.drop(); }

  private drop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.secret?.fill(0);
    this.secret = undefined;
    this.expiresAt = 0;
  }
}
