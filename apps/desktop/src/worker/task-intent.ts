import { redactOutput, type MessageDocument } from '@cloudhelm/core';
import { Value } from 'typebox/value';
import { TaskIntentStateSchema, type ClarificationRequest, type TaskIntentState, type TaskView } from '@cloudhelm/contracts';

/** Only prepared user intent or genuine text parts may authorize work; reference output may not. */
export function deriveInputIntent(text: string, document?: MessageDocument, prepared?: string): string {
  return prepared ?? (document ? document.parts.filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
    || '请分析这段终端输出' : text);
}

/** Current authorization intent only; native history/display projection never writes this ledger. */
export class TaskIntent {
  private value: TaskIntentState;
  constructor(private readonly task: Pick<TaskView, 'id' | 'goal' | 'intent'>,
    private readonly publish: (value: TaskIntentState) => void) {
    const saved = task.intent;
    if (saved && !Value.Check(TaskIntentStateSchema, saved)) {
      throw new Error('任务意图记录无效，不能从历史显示文本猜测授权');
    }
    this.value = saved ? structuredClone(saved) : { version: 1, revision: 0, originalGoal: redactOutput(task.goal),
      currentInput: redactOutput(task.goal), origin: 'legacy', clarifications: [] };
    this.value.clarifications = [...new Map(this.value.clarifications.map((item) => [item.id, item])).values()];
  }

  snapshot(): TaskIntentState { return structuredClone(this.value); }

  /** Only the real initial input can replace a short UI conversation title. */
  begin(text: string, requestId?: string): void {
    const input = redactOutput(text);
    this.commit({ ...this.value, originalGoal: input, currentInput: input, origin: 'explicit',
      lastInputId: requestId, clarifications: [] });
  }

  previewInput(text: string, newRound: boolean, requestId?: string): TaskIntentState {
    const input = redactOutput(text);
    if (requestId && requestId === this.value.lastInputId) {
      if (input !== this.value.currentInput) throw new Error('输入标识已绑定其他任务意图');
      return this.snapshot();
    }
    return structuredClone({ ...this.value, revision: this.value.revision + 1, currentInput: input, origin: 'explicit' as const,
      lastInputId: requestId, clarifications: newRound ? [] : this.value.clarifications });
  }
  input(text: string, newRound: boolean, requestId?: string): void {
    const next = this.previewInput(text, newRound, requestId);
    if (next.revision !== this.value.revision) this.commit(next);
  }

  clarify(request: ClarificationRequest): void {
    if (request.taskId !== this.task.id) throw new Error('澄清不属于本对话');
    if (request.status !== 'answered' || !request.answers || this.value.clarifications.some((item) => item.id === request.id)) return;
    const text = JSON.stringify(request.questions.map((question) => {
      const answer = request.answers!.find((item) => item.id === question.id);
      if (!answer) throw new Error('澄清回答不完整，不能更新任务意图');
      return { question: question.prompt, answer: answer.value,
        selectedLabel: answer.custom ? undefined : question.options?.find((option) => option.value === answer.value)?.label };
    }));
    this.commit({ ...this.value, clarifications: [...this.value.clarifications, { id: request.id, text: redactOutput(text) }] });
  }

  goal(): string {
    const { originalGoal, currentInput, clarifications, origin } = this.value;
    const current = origin === 'legacy' ? `历史任务标题（未保存独立的当前意图）：${currentInput}` : currentInput;
    return (originalGoal === currentInput ? current : `原始请求（背景，不代表重新执行授权）：${originalGoal}\n当前用户输入：${current}`)
      + (clarifications.length ? `\n已回答的需求澄清（不代替执行审批）：${JSON.stringify(clarifications)}` : '');
  }

  private commit(next: TaskIntentState): void {
    const value = structuredClone({ ...next, revision: this.value.revision + 1 });
    this.publish(structuredClone(value));
    this.value = value;
  }
}
