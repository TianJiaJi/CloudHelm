import { randomUUID } from 'node:crypto';
import { OutputRedactor, redactOutput } from '@cloudhelm/core';
import type { SqliteStore } from '@cloudhelm/adapters';
import type { AppEvent, ReferenceBody, ReferenceInfo, TerminalQuoteRequest } from '@cloudhelm/contracts';
import type { AppState } from './app-state.js';

interface Capture { key: string; generation: number; command?: string; running: boolean; exitCode?: number; length: number;
  truncated: boolean; redactor: OutputRedactor }

/** Capture is bounded at the source, not only at read time: an endless or noisy command
 * must not grow an unbounded log for the life of the terminal. 4 MiB is far above a
 * readable terminal transcript and far below a durable-store hazard. */
const CAPTURE_LIMIT = 4 * 1024 * 1024;
export const CAPTURE_TRUNCATION_MARKER = '\n[输出已截断：超出引用捕获上限，仅保留前面部分]\n';
export class ReferenceStore {
  private readonly commands = new Map<string, Capture>();
  constructor(private readonly store: SqliteStore, private readonly state: AppState,
    private readonly captureLimit = CAPTURE_LIMIT) {
    if (!Number.isSafeInteger(captureLimit) || captureLimit < 1024) throw new Error('Invalid reference capture limit');
  }
  record(event: AppEvent): void {
    if (event.type === 'terminal-command') {
      if (event.phase === 'unavailable') { this.commands.delete(event.terminalId); return; }
      if (event.phase === 'start') {
        this.commands.set(event.terminalId, { key: `quote-command:${randomUUID()}`, generation: event.generation,
          command: redactOutput(event.command ?? ''), running: true, length: 0, truncated: false,
          // A single unterminated line is bounded too; past the limit the redactor
          // discards instead of buffering, which keeps long minified output finite.
          redactor: new OutputRedactor(this.captureLimit) });
      } else {
        const capture = this.commands.get(event.terminalId);
        if (capture) { this.append(capture, capture.redactor.finish()); capture.running = false; capture.exitCode = event.exitCode; }
      }
    }
    if (event.type === 'terminal-data') {
      const capture = this.commands.get(event.terminalId);
      if (capture?.running) this.append(capture, capture.redactor.push(event.data));
    }
    if (event.type === 'terminal-state' && event.state === 'closed') {
      const capture = this.commands.get(event.terminalId);
      if (capture?.running) { this.append(capture, capture.redactor.finish()); capture.running = false; }
      this.commands.delete(event.terminalId);
    }
  }
  private append(capture: Capture, text: string): void {
    if (!text) return;
    const room = this.captureLimit - capture.length;
    if (room <= 0) { capture.truncated = true; return; }
    // Keep the stored bytes valid UTF-16 units; the marker explains the cut.
    const kept = text.length > room ? text.slice(0, room) : text;
    if (kept.length < text.length) capture.truncated = true;
    this.store.appendLog(capture.key, kept); capture.length += kept.length;
  }
  quote(input: TerminalQuoteRequest, recipient: string): ReferenceInfo {
    this.store.assertReferenceDraft(input.draftId, recipient, { conversationId: input.conversationId, hostId: input.hostId });
    const terminal = this.state.snapshot().terminals.find((item) => item.id === input.terminalId && item.hostId === input.hostId);
    if (!terminal) throw new Error('来源终端已关闭，请重新选择');
    if (input.conversationId && !this.state.getTask(input.conversationId).hostIds.includes(terminal.hostId)) throw new Error('引用主机与目标对话不一致');
    const capture = this.commands.get(terminal.id);
    if (input.selection !== undefined && (typeof input.selection !== 'string' || !input.selection.trim())) throw new Error('请选择要引用的内容');
    if (input.selection === undefined && !capture) throw new Error('无法识别命令范围，请先在终端选择要引用的内容');
    const original = input.selection !== undefined ? redactOutput(input.selection) :
      `${capture!.command ? `$ ${capture!.command}\n` : ''}${this.store.readCompleteLog(capture!.key, capture!.length)}${capture!.running ? capture!.redactor.snapshotTail() : ''}`
        + (capture!.truncated ? CAPTURE_TRUNCATION_MARKER : '');
    const reference: ReferenceInfo = { id: randomUUID(), kind: 'terminal', terminalId: terminal.id, hostId: terminal.hostId,
      hostLabel: this.state.getHost(terminal.hostId).label, generation: capture?.generation,
      command: input.selection === undefined ? capture?.command : undefined, capturedAt: Date.now(), running: input.selection === undefined ? capture?.running : undefined, exitCode: input.selection === undefined ? capture?.exitCode : undefined };
    this.store.saveDraftReference(input.draftId, recipient, { reference, original });
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
