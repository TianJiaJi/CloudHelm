import { createHash } from 'node:crypto';

/** Only backend-observed facts enter this index. Proposal IDs, assistant plans,
 * timestamps and wording are not observations. Store hashes, never raw output.
 * Keep prior hashes on continuation; eviction would make repeated pages novel. */
export class TaskProgress {
  private readonly seen = new Set<string>();
  private checkpoint = 0;
  private idle = 0;
  constructor(private readonly capacity = 4096) {}
  get idleTurns(): number { return this.idle; }
  get stalled(): boolean { return this.idle >= 10; }

  observe(kind: string, identity: string): void {
    const key = createHash('sha256').update(JSON.stringify([kind, identity])).digest('hex');
    if (this.seen.has(key)) return;
    if (this.seen.size >= this.capacity) throw new Error('进展索引已达上限，请拆分工作范围；不会遗忘旧观察以重复推进。');
    this.seen.add(key);
  }
  endTurn(): void {
    this.idle = this.seen.size > this.checkpoint ? 0 : this.idle + 1;
    this.checkpoint = this.seen.size;
  }
  reset(): void { this.idle = 0; this.checkpoint = this.seen.size; }
}
