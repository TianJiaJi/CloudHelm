import { randomUUID } from 'node:crypto';
import type { OperationView } from '@cloudhelm/contracts';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';

type Request = Extract<RuntimeMessage, { commitOperation: unknown }>;
interface Pending { taskId: string; operationId: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const unavailable = () => new Error('操作记录未获得持久化确认，不能据此发送或重发远端操作。');

/** An event publication is not a durable acknowledgment. Missing/late replies never authorize dispatch. */
export class OperationCommitClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly post: (message: Request) => void, private readonly timeoutMs = 30_000) {}
  commit(operation: OperationView): Promise<void> {
    if (this.closed || this.pending.size >= 256) return Promise.reject(unavailable());
    const id = randomUUID(), value = structuredClone(operation);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(id), this.timeoutMs);
      this.pending.set(id, { taskId: value.taskId, operationId: value.id, resolve, reject, timer });
      try { this.post({ commitOperation: { id, value } }); } catch { this.reject(id); }
    });
  }
  resolve(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') return;
    const pending = this.pending.get(raw.id);
    if (!pending) return;
    if (!('committed' in raw) || raw.committed !== true || !('taskId' in raw) || raw.taskId !== pending.taskId
      || !('operationId' in raw) || raw.operationId !== pending.operationId) { this.reject(raw.id); return; }
    this.take(raw.id)?.resolve();
  }
  close(): void { this.closed = true; for (const id of this.pending.keys()) this.reject(id); }
  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending) { this.pending.delete(id); clearTimeout(pending.timer); }
    return pending;
  }
  private reject(id: string): void { this.take(id)?.reject(unavailable()); }
}

export async function commitOperationSnapshot(operation: OperationView | undefined,
  commit?: (operation: OperationView) => Promise<void>): Promise<void> {
  if (!operation) throw unavailable();
  if (!commit) {
    if (operation.executionJob || operation.processControl) throw unavailable();
    return; // Legacy in-memory assemblies; production always supplies Main's durable authority.
  }
  try { await commit(structuredClone(operation)); } catch { throw unavailable(); }
}
