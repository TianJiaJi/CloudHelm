import { useRef, useState } from 'react';
import type { OperationView } from '@cloudhelm/contracts';
import { useUi } from './store.js';
import { jobLabel } from './execution-workspace-view.js';
import { capture } from './ui-helpers.js';
import styles from './execution-workspace.module.css';

export function ExecutionJobStatus({ operation, report }: { operation: OperationView; report(error: string): void }): React.JSX.Element | null {
  const execution = useUi((state) => state.snapshot?.execution?.[operation.taskId]);
  const [busy, setBusy] = useState(false), submitting = useRef(false);
  const job = operation.executionJob;
  if (!job) return null;
  const requested = !job.exitObserved && (!!job.stopRequestId || !!operation.interruption);
  const canStop = execution?.canStop === true && !execution.stopping && !requested && !job.exitObserved && !job.notStarted
    && ['starting', 'running'].includes(job.status);
  async function stop(): Promise<void> {
    if (!canStop || submitting.current) return;
    if (!window.confirm('将停止本会话的模型，并请求停止本会话全部正在执行的命令（包括后台任务）。这不保证进程已退出；结果仍须观察。继续？')) return;
    submitting.current = true; setBusy(true);
    try { await capture(() => window.cloudhelm.stopOperation(operation.taskId), report); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <section className={styles.panel} aria-label="后台任务状态" data-job-status={job.status}>
    <strong>{jobLabel(job)}</strong>
    <p>任务 {job.jobId} · 操作 {operation.id}</p><small>终端 {job.terminalId} · 代次 {job.terminalGeneration} · 进程 {job.pid ?? '未观察到'} / {job.processSequence}</small>
    {requested && <p role="status">已请求停止，尚未确认退出；不会自动重发。请查看后续退出观察或核验结果。</p>}
    {job.status === 'unknown' && <p role="alert">连接、控制权或结果不确定；不自动重放、切换身份或重启。</p>}
    <p className={styles.note}>运行不代表服务健康；模型回答结束也不代表后台进程结束。长期服务请使用服务管理器。</p>
    {canStop && <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void stop()}>{busy ? '正在请求…' : '停止本会话执行'}</button></div>}
  </section>;
}
