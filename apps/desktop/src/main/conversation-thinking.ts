import { modelThinking, type SqliteStore } from '@cloudhelm/adapters';
import type { TaskView, ThinkingLevel, ThinkingView } from '@cloudhelm/contracts';
import type { RuntimeProfile } from '@cloudhelm/contracts/runtime';

function selection(task: TaskView) {
  if (!task.provider) throw new Error('旧对话的模型绑定不可用，请创建新对话');
  return { provider: task.provider, modelId: task.modelId, baseUrl: task.baseUrl,
    contextWindow: task.contextWindow, maxTokens: task.maxTokens };
}

/** Model metadata only: no credentials, network or native session restoration. */
export function thinkingForRestore(task: TaskView): ThinkingLevel | undefined {
  const preferred = task.preferredThinking ?? task.thinking?.selected;
  if (preferred === undefined) return undefined;
  const choice = modelThinking(selection(task), preferred);
  return choice.levels.includes(choice.selected) ? choice.selected : undefined;
}

export function taskWithModel(task: TaskView, profile: RuntimeProfile, live: boolean): TaskView {
  const choice = modelThinking(profile, task.preferredThinking ?? task.thinking?.selected);
  const effective = task.thinking?.effective ?? choice.selected;
  return { ...task, provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl,
    contextWindow: profile.contextWindow, maxTokens: profile.maxTokens, credentialRevision: profile.credentialRevision,
    ...(task.preferredThinking === undefined ? {} : { preferredThinking: choice.selected }),
    thinking: { ...choice, effective, pending: !live || !!task.thinking?.pending || effective !== choice.selected }, updatedAt: Date.now() };
}

/** Persisted preference and observed runtime selection are different facts. */
export class ConversationThinking {
  private readonly observed = new Map<string, Pick<ThinkingView, 'selected' | 'pending'>>();
  constructor(private readonly store: Pick<SqliteStore, 'put'>, private readonly task: (id: string) => TaskView,
    private readonly replace: (task: TaskView) => void, private readonly publish: () => void) {}

  set(id: string, level: ThinkingLevel): void {
    const task = this.task(id), choice = modelThinking(selection(task));
    if (!choice.levels.includes(level)) throw new Error('当前模型不支持此思考档位');
    const observed = this.observed.get(id);
    const pending = !observed || observed.selected !== level || observed.pending;
    this.commit({ ...task, preferredThinking: level, thinking: { ...choice, selected: level, effective: task.thinking?.effective ?? 'off', pending }, updatedAt: Date.now() });
    this.publish();
  }

  pending(id: string): ThinkingLevel | undefined {
    const task = this.task(id);
    if (task.preferredThinking === undefined) return undefined;
    const level = thinkingForRestore(task);
    return level !== undefined && this.observed.get(id)?.selected !== level ? level : undefined;
  }

  observe(id: string, value: ThinkingView): void {
    const task = this.task(id), selected = task.preferredThinking ?? value.selected;
    this.commit({ ...task, thinking: { ...value, selected, pending: value.pending || selected !== value.selected } });
    this.observed.set(id, { selected: value.selected, pending: value.pending });
  }

  forget(id: string): void { this.observed.delete(id); }
  invalidate(): void { this.observed.clear(); }
  private commit(task: TaskView): void {
    const current = this.task(task.id);
    this.store.put('tasks', task.id, task);
    Object.assign(current, task);
    this.replace(current);
  }
}
