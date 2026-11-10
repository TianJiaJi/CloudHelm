import { randomUUID } from 'node:crypto';
import type { InputRequestView, SshConnectionSettings } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';

interface Dependencies {
  generation(hostId: string): number;
  connected(hostId: string): boolean;
  input(request: Omit<InputRequestView, 'id' | 'expiresAt'>, signal: AbortSignal): Promise<string | null>;
}
export interface ManualSessionGrant { signal: AbortSignal; settings: SshConnectionSettings; assertCurrent(): void; close(): void }

/** Human-session capability only. No Agent path calls this authorizer or receives
 * its result. Confirmation covers a captured configuration and connection generation. */
export class ManualSessionAuthorization {
  private readonly pending = new Set<string>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  constructor(private readonly deps: Dependencies) {}

  disconnect(hostId: string): void {
    for (const controller of this.controllers.get(hostId) ?? []) controller.abort();
    this.controllers.delete(hostId);
  }

  async authorize(host: RuntimeHost): Promise<ManualSessionGrant> {
    if (this.pending.has(host.id)) throw new Error('此主机已有人工终端配置等待确认');
    const controller = new AbortController(), generation = this.deps.generation(host.id);
    const controllers = this.controllers.get(host.id) ?? new Set<AbortController>();
    controllers.add(controller); this.controllers.set(host.id, controllers);
    const close = () => {
      controller.abort(); controllers.delete(controller);
      if (!controllers.size && this.controllers.get(host.id) === controllers) this.controllers.delete(host.id);
    };
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!this.deps.connected(host.id) || this.deps.generation(host.id) !== generation) throw new Error('SSH 连接已变化，人工终端配置确认已失效');
    };
    let settings = structuredClone<SshConnectionSettings>(host.connection ?? { version: 1 });
    const session = settings.session;
    const needsConfirmation = !!session?.initialization?.trim() || !!session?.keepaliveCommand?.trim()
      || !!session?.environment?.length || !!settings.x11?.enabled;
    try {
      assertCurrent();
      if (needsConfirmation) {
        this.pending.add(host.id);
        const choices = ['应用配置并打开终端', '仅打开基础终端（不执行配置命令或启用X11）'];
        const answer = await this.deps.input({ taskId: '', hostId: host.id, operationId: `manual-session:${randomUUID()}`, kind: 'confirmation',
          title: '确认人工终端启动配置', choices,
          explanation: `接收方：${host.username}@${host.address}:${host.port}，连接代次 ${generation}。\n这些设置仅用于本次人工终端，不会注入 AI 命令通道。配置中的命令可能修改远端。\n`
            + `默认目录：${session?.directory || '登录目录'}\n环境变量：${JSON.stringify(session?.environment ?? [])}\n`
            + `初始化命令：\n${session?.initialization || '无'}\n保活命令（独立通道，不写入前台程序；失败或结果未知后停止）：\n${session?.keepaliveCommand || '无'}\n`
            + `保活周期：${session?.keepaliveIntervalMs ?? 0} ms\nX11：${settings.x11?.enabled ? `启用，本机显示 :${settings.x11.display}.${settings.x11.screen}；远端 X 客户端可能访问本机 X 桌面，请仅信任已确认的主机` : '关闭'}`
        }, controller.signal);
        assertCurrent();
        if (answer === choices[1]) settings = { ...settings, session: { directory: session?.directory }, x11: undefined };
        else if (answer !== choices[0]) throw new Error('已取消人工终端启动；没有发送配置命令');
      }
      return { settings, signal: controller.signal, assertCurrent, close };
    } catch (error) { close(); throw error; }
    finally { this.pending.delete(host.id); }
  }
}
