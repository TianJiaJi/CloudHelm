import type { ExecutionTerminalBinding, ExecutionTerminalView } from '@cloudhelm/core';
import type { TerminalManager } from './terminal-manager.js';

interface Entry extends ExecutionTerminalBinding { terminalId: string; generation: number }
type Authority = Pick<TerminalManager, 'hostOf' | 'taskOf' | 'currentGeneration' | 'isAgentOwner' | 'stateOf' | 'hasPending' | 'close'>;
const key = (binding: ExecutionTerminalBinding) => JSON.stringify([binding.hostId, binding.loginAs, binding.connectionId]);

/** Bounded ordinary-Agent pool. Reuse never takes a human terminal or revives an
 * old generation. Selection does not grant approval or clear host outcome locks. */
export class ConversationTerminalPool {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<string>>();
  private disposed = false;
  constructor(private readonly taskId: string, private readonly terminal: Authority,
    private readonly open: (hostId: string, taskId: string, binding: ExecutionTerminalBinding) => Promise<string>,
    private readonly binding: (hostId: string) => ExecutionTerminalBinding,
    private readonly maximum = 4) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw new Error('Invalid terminal pool capacity');
  }

  private prune(): void {
    for (const [id] of this.entries) if (this.terminal.currentGeneration(id) < 0) this.entries.delete(id);
  }
  private matches(entry: Entry, binding: ExecutionTerminalBinding): boolean {
    return key(entry) === key(binding) && this.terminal.hostOf(entry.terminalId) === binding.hostId
      && this.terminal.taskOf(entry.terminalId) === this.taskId
      && this.terminal.currentGeneration(entry.terminalId) === entry.generation;
  }
  private check(binding: ExecutionTerminalBinding, assertCurrent: () => void): void {
    if (this.disposed) throw new Error('Conversation terminal pool is closed');
    assertCurrent();
    if (key(this.binding(binding.hostId)) !== key(binding)) throw new Error('Terminal identity/connection changed during allocation');
  }

  async acquire(hostId: string, assertCurrent: () => void): Promise<string> {
    const binding = this.binding(hostId);
    this.check(binding, assertCurrent); this.prune();
    const idle = [...this.entries.values()].find((entry) => this.matches(entry, binding)
      && this.terminal.isAgentOwner(entry.terminalId) && !this.terminal.hasPending(entry.terminalId));
    if (idle) return idle.terminalId;
    const openingKey = key(binding), existing = this.opening.get(openingKey);
    if (existing) {
      const id = await existing; this.check(binding, assertCurrent);
      const entry = this.entries.get(id);
      if (!entry || !this.matches(entry, binding) || !this.terminal.isAgentOwner(id) || this.terminal.hasPending(id))
        return this.acquire(hostId, assertCurrent);
      return id;
    }
    // Human-owned and suspended channels still consume resources until closed.
    if (this.entries.size + this.opening.size >= this.maximum)
      throw new Error('对话终端已达上限；请先停止或关闭不再需要的终端，不会抢占人工或运行中终端');
    const pending = this.open(binding.hostId, this.taskId, binding).then((id) => {
      const entry = { ...binding, terminalId: id, generation: this.terminal.currentGeneration(id) };
      // A foreign result must neither be adopted nor closed by this task.
      if (this.terminal.taskOf(id) !== this.taskId || this.terminal.hostOf(id) !== hostId)
        throw new Error('Terminal allocation returned a foreign session');
      this.entries.set(id, entry);
      try {
        this.check(binding, assertCurrent);
        if (!this.matches(entry, binding) || !this.terminal.isAgentOwner(id) || this.terminal.hasPending(id))
          throw new Error('New terminal is no longer idle and Agent-owned');
        return id;
      } catch (error) {
        // Only dispose an unused Agent terminal. A concurrent human takeover wins.
        if (this.terminal.isAgentOwner(id) && !this.terminal.hasPending(id)) this.terminal.close(id);
        throw error;
      }
    }).finally(() => { if (this.opening.get(openingKey) === pending) this.opening.delete(openingKey); });
    this.opening.set(openingKey, pending);
    return pending;
  }

  latest(hostId: string): string | undefined {
    return [...this.entries.values()].filter((entry) => entry.hostId === hostId).at(-1)?.terminalId;
  }
  owns(id: string): boolean { return this.entries.has(id) && this.terminal.taskOf(id) === this.taskId; }
  snapshot(): ExecutionTerminalView[] {
    this.prune();
    return [...this.entries.values()].map((entry) => ({ ...entry, taskId: this.taskId,
      generation: this.terminal.currentGeneration(entry.terminalId), owner: this.terminal.stateOf(entry.terminalId) ?? 'closed',
      busy: this.terminal.hasPending(entry.terminalId) }));
  }
  dispose(): void {
    this.disposed = true;
    for (const id of this.entries.keys()) if (this.terminal.taskOf(id) === this.taskId) this.terminal.close(id);
    this.entries.clear();
  }
}
