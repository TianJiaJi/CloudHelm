import { useRef, useState } from 'react';
import type { ExecutionView, ExtendRequestBudget, TaskView } from '@cloudhelm/contracts';
import styles from './ui.module.css';

/** Display backend state only. A click requests a grant; it does not locally
 * refill counters, clear a pause, or dispatch a separate resume request. */
export function RequestBudgetCard({ task, execution, report }: {
  task: TaskView; execution?: ExecutionView; report(message: string): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const binding = useRef<ExtendRequestBudget | null>(null);
  const budget = task.budget;
  const exhausted = !!budget && !budget.closed && budget.roundUsed >= budget.roundLimit;
  const extend = async (): Promise<void> => {
    if (!budget || pending.current) return;
    const previous = binding.current;
    if (!previous || previous.taskId !== task.id || previous.roundId !== budget.roundId || previous.budgetRevision !== budget.budgetRevision) {
      binding.current = { taskId: task.id, roundId: budget.roundId, budgetRevision: budget.budgetRevision, requestId: crypto.randomUUID() };
    }
    pending.current = true; setBusy(true);
    try {
      const result = await window.cloudhelm.extendRequestBudget(binding.current!);
      if (result.continuation === 'blocked') report('额度已追加；其他停止条件仍然有效，未自动继续。');
      if (result.continuation === 'uncertain') report('额度已保存，但继续请求的确认未知；不会自动重试，请先核对当前状态。');
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className={styles.agentActivity} role="status">
    <span>{budget ? `本轮请求 ${budget.roundUsed}/${budget.roundLimit} · 累计 ${budget.totalUsed}`
      : `累计请求 ${task.requestCount} · 轮次额度待后端确认`}</span>
    {exhausted && task.session && <button disabled={busy || execution?.model !== 'idle'}
      onClick={() => void extend()}>{busy ? '正在确认额度…' : '追加100次并继续'}</button>}
    {exhausted && <small>追加额度不会解除审核拒绝或远端安全限制。</small>}
  </div>;
}
