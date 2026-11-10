/** Main-process connection intent, including time spent waiting for a shared jump.
 * Cancelling the target must prevent its later dispatch even when the worker has
 * not received that target yet. A shared jump is not implicitly disconnected. */
export class HostConnectionAttempts {
  private readonly pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  run(hostId: string, connect: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const previous = this.pending.get(hostId);
    if (previous) return previous.promise;
    const controller = new AbortController(), { signal } = controller;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('SSH 连接已取消'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const work = Promise.resolve().then(async () => {
      signal.throwIfAborted(); await connect(signal); signal.throwIfAborted();
    });
    const promise = Promise.race([work, cancelled]).finally(() => {
      signal.removeEventListener('abort', abort);
      if (this.pending.get(hostId)?.controller === controller) this.pending.delete(hostId);
    });
    this.pending.set(hostId, { controller, promise });
    return promise;
  }

  cancel(hostId: string): void {
    const pending = this.pending.get(hostId);
    if (!pending) return;
    this.pending.delete(hostId); pending.controller.abort();
  }
}
