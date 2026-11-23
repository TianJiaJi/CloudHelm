import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactOutput, safeDiagnostic, type DiagnosticEvent } from '@cloudhelm/core';
import type { AppEvent, DebugReplayAction, DebugReplayView, OperationView } from '@cloudhelm/contracts';

/** Local-only, opt-in evidence capture. No reference expansion or private input channel. */
export class DebugReplay {
  private enabled = false;
  private error?: string;
  private sequence = 0;
  private captureId = '';
  readonly file: string;
  private readonly directory: string;

  constructor(private readonly userData: string, private readonly limit = 5 * 1024 * 1024) {
    this.directory = join(userData, 'debug-replay');
    this.file = join(this.directory, 'conversation.log');
  }

  control(action: DebugReplayAction): DebugReplayView {
    if (action === 'enable' && !this.enabled) {
      this.error = undefined; this.enabled = true; this.sequence = 0; this.captureId = randomUUID();
      this.write({ type: 'capture-start' });
    } else if (action === 'enable') { /* Already enabled. */ }
    else if (action === 'disable') this.enabled = false;
    else if (action === 'clear') {
      this.enabled = false;
      try { this.checkPath(false); unlinkSync(this.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法清除本地调试日志'); }
      this.error = undefined;
    } else if (action !== 'status' && action !== 'read') throw new Error('无效的调试操作');
    return { enabled: this.enabled, file: this.file, ...(this.error ? { error: this.error } : {}),
      ...(action === 'read' ? this.read() : {}) };
  }

  event(event: AppEvent): void {
    if (this.enabled && event.type === 'task-message' && (event.role === 'user' || event.role === 'agent') && event.source !== 'clarification') {
      const text = event.document ? event.document.parts.map((part) => part.type === 'text' ? part.text : '[引用正文未记录]').join('') : event.text;
      this.write({ type: 'message', taskId: event.taskId, role: event.role, entryId: event.entryId,
        createdAt: event.createdAt, text: redactOutput(text) });
    }
  }

  diagnostic(event: DiagnosticEvent): void {
    if (this.enabled && ['task.status', 'model.request', 'model.response', 'tool.start', 'tool.end', 'tool.refused', 'review.result', 'operation'].includes(event.event)) {
      this.write({ type: 'diagnostic', ...safeDiagnostic(event) });
    }
  }

  operation(value: OperationView): void {
    if (!this.enabled) return;
    this.write({ type: 'operation-record', taskId: value.taskId, operationId: value.id, toolCallId: value.toolCallId,
      status: value.status, ruleId: value.ruleId, failureKind: value.failureKind, readOnly: value.readOnly,
      exitCode: value.exitCode, effects: value.effects, preview: redactOutput(value.preview),
      reconciliation: value.reconciliation?.kind, recoveryAction: value.recoveryDecision?.action,
      recoveryActionId: value.recoveryDecision?.actionId, recoveryResumed: value.recoveryDecision?.resumed,
      recoveryNote: value.recoveryDecision?.resumeNote ? redactOutput(value.recoveryDecision.resumeNote) : undefined,
      recoveryError: value.recoveryDecision?.error ? redactOutput(value.recoveryDecision.error) : undefined });
  }

  private checkPath(create: boolean): void {
    if (lstatSync(this.userData).isSymbolicLink()) throw new Error('Invalid log root');
    if (create) {
      try { mkdirSync(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!lstatSync(this.directory).isDirectory()) throw new Error('Invalid log directory');
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid log file');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private write(record: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      const line = JSON.stringify({ version: 1, captureId: this.captureId, time: new Date().toISOString(), sequence: ++this.sequence, ...record }) + '\n';
      this.checkPath(true);
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid log file');
        if (stat.size + Buffer.byteLength(line) > this.limit) {
          this.enabled = false;
          this.error = '详细日志已达容量上限，记录已停止。可先保留文件，再清除并重新开启。';
          return;
        }
        writeFileSync(fd, line);
      } finally { closeSync(fd); }
    } catch {
      this.enabled = false;
      this.error = '详细日志写入失败，记录已停止。普通诊断与操作不受影响。';
    }
  }

  private read(): { text: string } {
    try {
      this.checkPath(false);
      const fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.limit) throw new Error('Invalid log size');
        return { text: readFileSync(fd, 'utf8') };
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' };
      throw new Error('无法读取本地调试日志');
    }
  }
}
