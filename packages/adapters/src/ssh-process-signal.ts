import { randomBytes } from 'node:crypto';

/** One signal attempt on one existing supervised process. An acknowledgement is
 * never an exit report. No PID lookup, shell command, reconnect, or retry occurs. */
export class ProcessInterrupt {
  private closed = false;
  private request?: { id: string; promise: Promise<'sent' | 'already-exited'>;
    resolve(value: 'sent' | 'already-exited'): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  constructor(private readonly pid: number, private readonly current: () => void,
    private readonly send: (message: { type: 'signal'; signal: 'SIGINT'; pid: number; id: string }) => void) {}

  interrupt(expectedPid: number): Promise<'sent' | 'already-exited'> {
    if (this.closed || expectedPid !== this.pid) return Promise.reject(new Error('进程绑定已变化；停止信号未发送'));
    if (this.request) return this.request.promise;
    try { this.current(); } catch { return Promise.reject(new Error('进程控制权限已失效；停止信号未发送')); }
    let resolve!: (value: 'sent' | 'already-exited') => void, reject!: (error: Error) => void;
    const promise = new Promise<'sent' | 'already-exited'>((done, fail) => { resolve = done; reject = fail; });
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => reject(new Error('停止信号未获得确认；进程可能仍在运行，不会自动重发')), 5000);
    this.request = { id, promise, resolve, reject, timer };
    try { this.send({ type: 'signal', signal: 'SIGINT', pid: this.pid, id }); }
    catch { clearTimeout(timer); reject(new Error('停止信号投递结果未知；请核验原任务')); }
    return promise;
  }

  receive(event: Record<string, unknown>): boolean {
    if (event.type !== 'signal-result' || !this.request || event.id !== this.request.id || event.pid !== this.pid
      || !['sent', 'already-exited'].includes(String(event.status))) return false;
    clearTimeout(this.request.timer);
    this.request.resolve(event.status as 'sent' | 'already-exited');
    return true;
  }

  close(): void {
    this.closed = true;
    if (!this.request) return;
    clearTimeout(this.request.timer);
    this.request.reject(new Error('进程观察通道已结束；停止请求不代表进程已退出'));
  }
}
