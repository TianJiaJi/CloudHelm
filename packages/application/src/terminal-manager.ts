import { CommandNotStartedError } from '@cloudhelm/core';
import { randomUUID } from 'node:crypto';
import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation, RawTerminal, TerminalLease } from '@cloudhelm/core';
import { operationFingerprint, OutputRedactor } from '@cloudhelm/core';

type Owner = 'agent' | 'human' | 'suspended' | 'closed';

interface PendingCommand {
  output: string;
  redactor: OutputRedactor;
  failure?: Pick<OperationResult, 'failureKind' | 'effects'>;
  settle(result: OperationResult): void;
  remoteCompletion: Promise<'exited' | 'unknown'>;
  completeRemote(state: 'exited' | 'unknown'): void;
  reported: boolean;
  operationId: string;
  stopRequested?: boolean;
}

interface TerminalRecord {
  id: string;
  hostId: string;
  taskId?: string;
  generation: number;
  home: string;
  owner: Owner;
  channel: RawTerminal;
  pending?: PendingCommand;
}

export interface TerminalEvents {
  data(terminalId: string, data: string, operationId?: string): void;
  completed?(result: OperationResult): void;
  state(terminalId: string, owner: Owner): void;
}

/** Sole writer to SSH PTYs; review grants never bypass the current ownership generation. */
export class TerminalManager implements TerminalLease, OperationExecutor {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly listeners = new Map<string, Set<(data: string) => void>>();

  constructor(private readonly events: TerminalEvents) {}

  open(hostId: string, channel: RawTerminal, taskId?: string, home = '/'): string {
    const terminal: TerminalRecord = {
      id: randomUUID(), hostId, taskId, home, generation: 1, owner: taskId ? 'agent' : 'human', channel
    };
    this.terminals.set(terminal.id, terminal);
    channel.onData((data) => this.receive(terminal, data));
    channel.onDisplay?.((data) => this.events.data(terminal.id, data));
    channel.onClose(() => this.closeRecord(terminal));
    channel.onExecutionFailure?.((failure) => { if (terminal.pending) terminal.pending.failure = failure; });
    channel.onExit?.((code) => this.complete(terminal, code));
    this.events.state(terminal.id, terminal.owner);
    return terminal.id;
  }

  currentGeneration(id: string): number { return this.terminals.get(id)?.generation ?? -1; }
  isAgentOwner(id: string): boolean { return this.terminals.get(id)?.owner === 'agent'; }
  workingDirectory(id: string): string { return this.require(id).home; }
  hostOf(id: string): string | undefined { return this.terminals.get(id)?.hostId; }
  taskOf(id: string): string | undefined { return this.terminals.get(id)?.taskId; }
  subscribeData(id: string, listener: (data: string) => void): () => void {
    this.require(id);
    const set = this.listeners.get(id) ?? new Set<(data: string) => void>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  subscribeAuthentication(id: string, listener: (challenge: { id: string; prompt?: string }) => void): () => void {
    const channel = this.require(id).channel;
    channel.onAuthentication?.(listener);
    return () => channel.onAuthentication?.(() => {});
  }

  answerAuthentication(id: string, operationId: string, challengeId: string, answer: string | null): boolean {
    const terminal = this.require(id);
    if (terminal.pending?.operationId !== operationId || (answer !== null && terminal.owner !== 'agent')) return false;
    return terminal.channel.answerAuthentication?.(challengeId, answer) ?? false;
  }

  confirmInput(id: string, operationId: string, answer: string): boolean {
    const terminal = this.require(id);
    if (terminal.pending?.operationId !== operationId || terminal.owner !== 'agent') return false;
    terminal.channel.write(answer);
    return true;
  }

  hasPending(id: string): boolean { return !!this.terminals.get(id)?.pending; }
  pendingOperations(taskId: string): string[] {
    return [...this.terminals.values()].flatMap((terminal) => terminal.taskId === taskId && terminal.pending ? [terminal.pending.operationId] : []);
  }
  releaseIdle(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.pending) this.takeOver(id);
  }

  input(id: string, data: string, humanIntent: boolean): void {
    const terminal = this.require(id);
    if (!humanIntent) { if (this.isProtocolResponse(data)) terminal.channel.write(data); return; }
    if (terminal.owner !== 'human' || terminal.pending) throw new Error('终端暂不可输入，请先停止 AI 并等待命令退出');
    terminal.channel.write(data);
  }

  takeOver(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'agent' && terminal.owner !== 'suspended') return;
    terminal.generation++;
    terminal.owner = 'human';
    terminal.channel.takeOver?.();
    if (terminal.pending && !terminal.pending.reported) {
      const pending = terminal.pending;
      pending.reported = true;
      pending.settle({ operationId: pending.operationId, status: 'handed-over',
        stdoutTail: pending.output.slice(-16_384), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    this.events.state(id, 'human');
  }

  suspend(id: string): void {
    const terminal = this.require(id);
    if (terminal.owner !== 'agent') return;
    terminal.generation++;
    terminal.owner = 'suspended';
    if (terminal.pending && !terminal.pending.reported) {
      const pending = terminal.pending;
      pending.reported = true;
      pending.settle({ operationId: pending.operationId, status: 'unknown',
        stdoutTail: pending.output.slice(-16_384), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
    }
    this.events.state(id, 'suspended');
  }

  resize(id: string, cols: number, rows: number): void {
    this.require(id).channel.resize(cols, rows);
  }

  close(id: string): void {
    const terminal = this.require(id);
    this.suspend(id);
    terminal.channel.close();
  }

  stopCommand(id: string): void {
    const terminal = this.require(id);
    if (!terminal.pending || terminal.pending.stopRequested) return;
    terminal.pending.stopRequested = true;
    // Only invoked by an explicit user stop action, never to recover a shell.
    try { terminal.channel.write('\u0003'); } catch (error) { terminal.pending.stopRequested = false; throw error; } finally { this.suspend(id); }
  }

  stopTaskCommands(taskId: string): void {
    const errors: unknown[] = [];
    for (const terminal of this.terminals.values()) if (terminal.taskId === taskId && terminal.pending) {
      try { this.stopCommand(terminal.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('部分命令的停止信号未送达，请核验远端状态');
  }

  closeHost(hostId: string): void {
    for (const terminal of this.terminals.values()) if (terminal.hostId === hostId) this.close(terminal.id);
  }

  async execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult> {
    const terminal = this.require(operation.scope.terminalId);
    if (operation.kind !== 'command') throw new Error('Structured file operations require a separate audited executor');
    if (terminal.taskId !== operation.scope.taskId || terminal.hostId !== operation.scope.hostId
      || terminal.owner !== 'agent' || terminal.generation !== operation.scope.terminalGeneration
      || operationFingerprint(operation) !== fingerprint || signal?.aborted || terminal.pending || options?.isAuthorized?.() === false) {
      throw new Error('Agent terminal authorization expired');
    }
    if (!terminal.channel.execute) throw new Error('This terminal does not support direct process execution');
    return new Promise<OperationResult>((resolve) => {
      let completeRemote!: (state: 'exited' | 'unknown') => void;
      const remoteCompletion = new Promise<'exited' | 'unknown'>((done) => { completeRemote = done; });
      const pending: PendingCommand = { output: '', redactor: new OutputRedactor(), operationId: operation.id, settle: resolve,
        remoteCompletion, completeRemote, reported: false };
      terminal.pending = pending;
      signal?.addEventListener('abort', () => {
        if (terminal.pending !== pending) return;
        terminal.generation++;
        terminal.owner = 'suspended';
        this.events.state(terminal.id, 'suspended');
        if (!pending.reported) {
          pending.reported = true;
          resolve({ operationId: operation.id, status: 'unknown', stdoutTail: pending.output.slice(-16_384),
            logRef: terminal.id, remoteCompletion });
        }
      }, { once: true });
      const current = () => !signal?.aborted && terminal.owner === 'agent'
        && terminal.generation === operation.scope.terminalGeneration && options?.isAuthorized?.() !== false;
      if (!terminal.channel.onDisplay) this.events.data(terminal.id, `$ ${operation.command}\r\n`);
      void terminal.channel.execute!(operation.command, operation.scope.cwd, current).catch((error: unknown) => {
        this.receive(terminal, error instanceof Error ? error.message : 'Command transport failed');
        if (error instanceof CommandNotStartedError && terminal.pending === pending) {
          pending.failure = { failureKind: 'unsupported', effects: 'none' };
          this.complete(terminal, 127);
        } else this.complete(terminal, undefined);
      });
    });
  }

  private receive(terminal: TerminalRecord, data: string): void {
    const pending = terminal.pending;
    this.events.data(terminal.id, data, pending?.operationId);
    if (pending) pending.output = (pending.output + pending.redactor.push(data)).slice(-65_536);
    for (const listener of this.listeners.get(terminal.id) ?? []) listener(data);
  }

  private complete(terminal: TerminalRecord, exitCode: number | undefined): void {
    const pending = terminal.pending;
    if (!pending) return;
    terminal.pending = undefined;
    pending.output = (pending.output + pending.redactor.finish()).slice(-65_536);
    pending.completeRemote(exitCode === undefined ? 'unknown' : 'exited');
    const result: OperationResult = { operationId: pending.operationId,
      status: exitCode === undefined ? 'unknown' : exitCode === 0 ? 'succeeded' : 'failed',
      failureKind: exitCode === undefined ? 'unknown' : exitCode && /permission denied|operation not permitted/iu.test(pending.output) ? 'permission-denied' : undefined,
      effects: exitCode === 0 ? undefined : 'possible', ...pending.failure,
      exitCode, stdoutTail: pending.output.slice(-16_384), logRef: terminal.id };
    this.events.completed?.(result);
    if (!pending.reported) pending.settle(result);
  }

  private closeRecord(terminal: TerminalRecord): void {
    terminal.owner = 'closed';
    terminal.generation++;
    // Publish loss of observability even if Stop already settled the tool call.
    this.complete(terminal, undefined);
    this.events.state(terminal.id, 'closed');
    this.listeners.delete(terminal.id);
    this.terminals.delete(terminal.id);
  }

  private isProtocolResponse(data: string): boolean {
    return /^(?:\u001b\[(?:\?|>)[\d;]*c|\u001b\[\d+;\d+R)$/u.test(data);
  }

  private require(id: string): TerminalRecord {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Terminal not found');
    return terminal;
  }
}
