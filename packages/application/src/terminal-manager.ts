import { CommandNotStartedError } from '@cloudhelm/core';
import { randomUUID } from 'node:crypto';
import type { ExecutionOptions, OperationExecutor, OperationResult, ProposedOperation, RawTerminal, TerminalLease } from '@cloudhelm/core';
import { operationFingerprint, validProcessControl } from '@cloudhelm/core';
import { OperationOutputCapture } from './operation-output-capture.js';

type Owner = 'agent' | 'human' | 'suspended' | 'closed';

interface PendingCommand {
  generation: number;
  pid?: number;
  readOnly?: boolean;
  isAuthorized(): boolean;
  onProcessStarted?: (event: { pid: number }) => void;
  capture: OperationOutputCapture;
  failure?: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege' | 'requiresUserAction'>;
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
  commandRunning?: boolean;
}

export interface TerminalEvents {
  cwd?(terminalId: string, directory: string): void;
  command?(terminalId: string, generation: number, event: { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }): void;
  data(terminalId: string, data: string, operationId?: string): void;
  completed?(result: OperationResult): void;
  processStarted?(terminalId: string, operationId: string, generation: number, pid: number): void;
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
    channel.onCommand?.((event) => { terminal.commandRunning = event.phase === 'start'; this.events.command?.(terminal.id, terminal.generation, event); });
    channel.onCwd?.((directory) => {
      if (terminal.owner !== 'human' || terminal.taskId || !directory.startsWith('/') || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory)) return;
      terminal.home = directory; this.events.cwd?.(terminal.id, directory);
    });
    channel.onData((data) => this.receive(terminal, data));
    channel.onDisplay?.((data) => this.events.data(terminal.id, data));
    channel.onClose(() => this.closeRecord(terminal));
    channel.onExecutionFailure?.((failure) => { if (terminal.pending) terminal.pending.failure = failure; });
    channel.onProcessStarted?.((event) => {
      const pending = terminal.pending;
      if (!pending || !pending.isAuthorized() || terminal.owner !== 'agent' || terminal.generation !== pending.generation
        || !Number.isSafeInteger(event.pid) || event.pid < 1 || event.pid > 2147483647) return;
      pending.pid = event.pid;
      this.events.processStarted?.(terminal.id, pending.operationId, pending.generation, event.pid);
      if (terminal.pending === pending && pending.isAuthorized()) pending.onProcessStarted?.(event);
    });
    channel.onExit?.((code) => this.complete(terminal, code));
    this.events.state(terminal.id, terminal.owner);
    return terminal.id;
  }

  currentGeneration(id: string): number { return this.terminals.get(id)?.generation ?? -1; }
  stateOf(id: string): Owner | undefined { return this.terminals.get(id)?.owner; }
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
    if (!terminal.commandRunning && /[\r\n]/u.test(data)) this.events.command?.(terminal.id, terminal.generation, { phase: 'unavailable' });
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
        ...pending.capture.snapshot(), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
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
        ...pending.capture.snapshot(), logRef: terminal.id, remoteCompletion: pending.remoteCompletion });
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

  /** Exact-operation signal delivery. The caller must pass a current control grant;
   * this method grants no authority and never treats acknowledgement as process exit. */
  interruptOperation(operation: ProposedOperation, fingerprint: string, isAuthorized: () => boolean): Promise<'sent' | 'already-exited'> {
    const control = operation.kind === 'command' ? operation.processControl : undefined;
    if (!control || !validProcessControl(operation) || operationFingerprint(operation) !== fingerprint || !isAuthorized())
      throw new Error('Process control authorization expired');
    const terminal = this.require(operation.scope.terminalId), pending = terminal.pending;
    if (!pending || terminal.owner !== 'agent' || pending.operationId !== control.targetOperationId
      || pending.pid !== control.pid || pending.generation !== operation.scope.terminalGeneration
      || terminal.generation !== operation.scope.terminalGeneration || terminal.hostId !== operation.scope.hostId
      || terminal.taskId !== operation.scope.taskId || pending.stopRequested || !terminal.channel.interrupt)
      throw new Error('Process control recipient changed or stop was already requested');
    const acknowledgement = terminal.channel.interrupt(control.pid);
    pending.stopRequested = true;
    return acknowledgement;
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
    if (operation.processControl) throw new Error('Process control cannot be executed as a shell command');
    if (terminal.taskId !== operation.scope.taskId || terminal.hostId !== operation.scope.hostId
      || terminal.owner !== 'agent' || terminal.generation !== operation.scope.terminalGeneration
      || operationFingerprint(operation) !== fingerprint || signal?.aborted || terminal.pending || options?.isAuthorized?.() === false) {
      throw new Error('Agent terminal authorization expired');
    }
    if (!terminal.channel.execute) throw new Error('This terminal does not support direct process execution');
    return new Promise<OperationResult>((resolve) => {
      let completeRemote!: (state: 'exited' | 'unknown') => void;
      const remoteCompletion = new Promise<'exited' | 'unknown'>((done) => { completeRemote = done; });
      const current = () => !signal?.aborted && terminal.owner === 'agent'
        && terminal.generation === operation.scope.terminalGeneration && options?.isAuthorized?.() !== false;
      const pending: PendingCommand = { generation: operation.scope.terminalGeneration, isAuthorized: current, onProcessStarted: options?.onProcessStarted,
        readOnly: options?.readOnly, capture: new OperationOutputCapture(), operationId: operation.id, settle: resolve,
        remoteCompletion, completeRemote, reported: false };
      terminal.pending = pending;
      this.events.command?.(terminal.id, terminal.generation, { phase: 'start', command: operation.command });
      signal?.addEventListener('abort', () => {
        if (terminal.pending !== pending || terminal.owner !== 'agent' || terminal.generation !== pending.generation) return;
        terminal.generation++;
        terminal.owner = 'suspended';
        this.events.state(terminal.id, 'suspended');
        if (!pending.reported) {
          pending.reported = true;
          resolve({ operationId: operation.id, status: 'unknown', ...pending.capture.snapshot(),
            logRef: terminal.id, remoteCompletion });
        }
      }, { once: true });
      if (!terminal.channel.onDisplay) this.events.data(terminal.id, `$ ${operation.command}\r\n`);
      void terminal.channel.execute!(operation.command, operation.scope.cwd, current,
        { sudoAuthorization: operation.privilege === 'root', executionChannel: operation.executionChannel }).catch((error: unknown) => {
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
    pending?.capture.push(data);
    for (const listener of this.listeners.get(terminal.id) ?? []) listener(data);
  }

  private complete(terminal: TerminalRecord, exitCode: number | undefined): void {
    const pending = terminal.pending;
    if (!pending) return;
    terminal.pending = undefined;
    this.events.command?.(terminal.id, terminal.generation, { phase: 'end', exitCode });
    pending.capture.finish();
    pending.completeRemote(exitCode === undefined ? 'unknown' : 'exited');
    const notDispatched = exitCode === undefined && pending.failure?.failureKind === 'not-dispatched'
      && pending.failure.effects === 'none';
    const result: OperationResult = { operationId: pending.operationId,
      status: notDispatched ? 'failed' : exitCode === undefined ? 'unknown' : exitCode === 0 ? 'succeeded' : 'failed',
      failureKind: exitCode === undefined ? 'unknown' : exitCode && /permission denied|operation not permitted/iu.test(pending.capture.text) ? 'permission-denied' : undefined,
      effects: exitCode === 0 || pending.readOnly ? undefined : 'possible', ...pending.failure,
      exitCode, ...pending.capture.snapshot(), logRef: terminal.id };
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
