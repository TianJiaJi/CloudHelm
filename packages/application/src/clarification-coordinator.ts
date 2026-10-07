import { randomUUID } from 'node:crypto';
import { normalizeAnswers, validateQuestions, type ClarificationAnswer, type ClarificationPort, type ClarificationQuestion, type ClarificationRequest } from '@cloudhelm/core';

/** One live question batch per conversation; IDs never survive a runtime generation. */
export class ClarificationCoordinator implements ClarificationPort {
  private pending?: { request: ClarificationRequest; resolve(answers: ClarificationAnswer[]): void; reject(error: Error): void; cleanup(): void };
  private readonly generation = randomUUID();
  constructor(private readonly taskId: string, private readonly changed: (request: ClarificationRequest) => void,
    private readonly interrupted: () => void, private readonly timeoutMs = 24 * 60 * 60_000) {}

  ask(toolCallId: string, questions: ClarificationQuestion[], signal?: AbortSignal): Promise<ClarificationAnswer[]> {
    validateQuestions(questions);
    if (signal?.aborted) return Promise.reject(new Error('用户已停止本轮对话'));
    if (this.pending) return Promise.reject(new Error('本对话已有待回答的问题'));
    const request: ClarificationRequest = { id: randomUUID(), taskId: this.taskId, toolCallId, generation: this.generation,
      questions: structuredClone(questions), status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + this.timeoutMs };
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(request.id);
      const timer = setTimeout(() => this.cancel(request.id, 'expired'), this.timeoutMs);
      this.pending = { request, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.changed(structuredClone(request));
    });
  }

  answer(id: string, input: unknown): void {
    const pending = this.requirePending(id);
    if (Date.now() >= pending.request.expiresAt) { this.cancel(id, 'expired'); throw new Error('问题已过期'); }
    const answers = normalizeAnswers(pending.request.questions, input);
    this.pending = undefined; pending.cleanup();
    this.changed({ ...pending.request, status: 'answered', answers });
    pending.resolve(answers);
  }

  cancel(id?: string, status: 'cancelled' | 'expired' = 'cancelled'): void {
    if (!id && !this.pending) return;
    const pending = this.requirePending(id ?? this.pending!.request.id);
    this.pending = undefined; pending.cleanup();
    // Stop the Agent before rejecting the tool; a tool error alone would make it guess and continue.
    this.interrupted();
    this.changed({ ...pending.request, status });
    pending.reject(new Error(status === 'expired' ? '问题已过期；等待用户发起新的对话轮次' : '用户取消了需求澄清；不得猜测回答或继续执行'));
  }

  private requirePending(id: string) {
    if (!this.pending || this.pending.request.id !== id) throw new Error('问题已失效或已经回答');
    return this.pending;
  }
}
