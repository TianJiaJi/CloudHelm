import { randomUUID } from 'node:crypto';
import type { StoredConversationInput } from '@cloudhelm/contracts';
import type { RuntimeMessage } from '@cloudhelm/contracts/runtime';
const unavailable = () => new Error('消息队列未获得持久化确认，未获准继续投递。');
export class InputCommitClient {
  private readonly pending = new Map<string, { taskId: string; inputId: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly post: (message: Extract<RuntimeMessage, { commitInput: unknown }>) => void) {}
  commit(value: StoredConversationInput): Promise<void> {
    if (this.pending.size >= 256) return Promise.reject(unavailable());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, false), 30_000);
      this.pending.set(id, { taskId: value.taskId, inputId: value.id, resolve, reject, timer });
      try { this.post({ commitInput: { id, value: structuredClone(value) } }); } catch { this.finish(id, false); }
    });
  }
  resolve(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') return;
    const entry = this.pending.get(raw.id);
    if (!entry) return;
    this.finish(raw.id, 'committed' in raw && raw.committed === true
      && 'taskId' in raw && raw.taskId === entry.taskId && 'inputId' in raw && raw.inputId === entry.inputId);
  }
  private finish(id: string, committed: boolean): void {
    const entry = this.pending.get(id); if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer);
    if (committed) entry.resolve(); else entry.reject(unavailable());
  }
}
