import type { AppEvent, LocalScope, TaskView } from '@cloudhelm/contracts';
import type { PreparedContext, RuntimeHost } from '@cloudhelm/contracts/runtime';
import { assertPreparedInput, type PreparationSnapshot } from './task-preparation.js';

/** Preview is pure. Validate both old context and prospective frame before grant. */
export function authorizeTaskInput(task: TaskView, hosts: RuntimeHost[], additions: RuntimeHost[], scopes: LocalScope[],
  snapshot: (scopes?: LocalScope[]) => PreparationSnapshot, event: (event: AppEvent) => void,
  prepared?: PreparedContext & { text: string }): void {
  if (prepared) {
    if (additions.length) throw new Error('准备后主机授权已变化，请重新发送');
    assertPreparedInput(snapshot(), prepared.beforeRevision, '');
    assertPreparedInput(snapshot(scopes), prepared.revision, prepared.text);
  }
  for (const host of additions) if (!hosts.some((candidate) => candidate.id === host.id)) {
    hosts.push(host); task.hostIds.push(host.id);
  }
  task.localScopes.push(...scopes);
  event({ type: 'task-message', taskId: task.id, role: 'system',
    text: `授权范围已更新：${additions.map((host) => host.label).join('、') || '主机不变'}；新增本地资料 ${scopes.length} 项。`, createdAt: Date.now() });
}
