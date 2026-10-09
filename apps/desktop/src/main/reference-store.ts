import { randomUUID } from 'node:crypto';
import { OutputRedactor, redactOutput } from '@cloudhelm/core';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ReferenceBody, ReferenceInfo, TerminalQuoteRequest } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';

interface Capture { key: string; generation: number; command?: string; running: boolean; exitCode?: number; length: number; redactor: OutputRedactor }
export class ReferenceStore {
  private readonly commands = new Map<string, Capture>();
  constructor(private readonly store: SqliteStore, private readonly state: AppState) {}
  record(event: AppEvent): void {
    if (event.type === 'terminal-command') {
      if (event.phase === 'unavailable') { this.commands.delete(event.terminalId); return; }
      if (event.phase === 'start') {
        this.commands.set(event.terminalId, { key: `quote-command:${randomUUID()}`, generation: event.generation,
          command: redactOutput(event.command ?? ''), running: true, length: 0, redactor: new OutputRedactor(Infinity) });
      } else {
        const capture = this.commands.get(event.terminalId);
        if (capture) { this.append(capture, capture.redactor.finish()); capture.running = false; capture.exitCode = event.exitCode; }
      }
    }
    if (event.type === 'terminal-data') {
      const capture = this.commands.get(event.terminalId);
      if (capture?.running) this.append(capture, capture.redactor.push(event.data));
    }
    if (event.type === 'terminal-state' && event.state === 'closed') this.commands.delete(event.terminalId);
  }
  private append(capture: Capture, text: string): void {
    if (!text) return;
    this.store.appendLog(capture.key, text); capture.length += text.length;
  }
  quote(input: TerminalQuoteRequest): ReferenceInfo {
    const terminal = this.state.snapshot().terminals.find((item) => item.id === input.terminalId && item.hostId === input.hostId);
    if (!terminal) throw new Error('来源终端已关闭，请重新选择');
    if (input.conversationId && !this.state.getTask(input.conversationId).hostIds.includes(terminal.hostId)) throw new Error('引用主机与目标对话不一致');
    const capture = this.commands.get(terminal.id);
    if (input.selection !== undefined && (typeof input.selection !== 'string' || !input.selection.trim())) throw new Error('请选择要引用的内容');
    if (input.selection === undefined && !capture) throw new Error('无法识别命令范围，请先在终端选择要引用的内容');
    const original = input.selection !== undefined ? redactOutput(input.selection) :
      `${capture!.command ? `$ ${capture!.command}\n` : ''}${this.store.readCompleteLog(capture!.key, capture!.length)}${capture!.running ? capture!.redactor.snapshotTail() : ''}`;
    const reference: ReferenceInfo = { id: randomUUID(), kind: 'terminal', terminalId: terminal.id, hostId: terminal.hostId,
      hostLabel: this.state.getHost(terminal.hostId).label, generation: capture?.generation,
      command: input.selection === undefined ? capture?.command : undefined, capturedAt: Date.now(), running: input.selection === undefined ? capture?.running : undefined, exitCode: input.selection === undefined ? capture?.exitCode : undefined };
    this.store.putReference(reference.id, { reference, original });
    return reference;
  }
  read(id: string): ReferenceBody {
    if (typeof id !== 'string') throw new Error('Invalid reference');
    const body = this.store.readReference<ReferenceBody>(id);
    if (!body) throw new Error('引用资料不存在，请重新添加');
    return body;
  }
  save(body: ReferenceBody): void { this.store.putReference(body.reference.id, body); }
}
