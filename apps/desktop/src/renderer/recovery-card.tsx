import { useState } from 'react';
import { operationNeedsVerification, operationOutcomeResolvable, sharesHostRiskDomain, type AppSnapshot, type OperationView, type TaskView } from '@cloudhelm/contracts';
import { Button, Card } from './ui/index.js';
import styles from './ui.module.css';

const RISK_EXPLANATION = '用户在恢复卡明确知晓原远端操作结果未知且可能继续运行，自愿接管此项未决风险。';
const REJECTION_EXPLANATION = '用户在恢复卡明确拒绝接管未知结果风险，保持写入阻断。';

function RecoveryItem({ operation, snapshot, conversation, current, remaining, hostId, report }: {
  operation: OperationView; snapshot: AppSnapshot; conversation: TaskView; hostId: string;
  current?: OperationView; remaining: number; report(error: string): void;
}): React.JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const source = snapshot.conversations.find((item) => item.id === operation.taskId && item.hostIds.includes(operation.hostId));
  const request = snapshot.messages.filter((item) => item.taskId === conversation.id && item.role === 'user').at(-1)?.text;
  const resolvable = operationOutcomeResolvable(operation);
  async function readLog(): Promise<void> {
    setBusy(true);
    try {
      const page = await window.cloudhelm.readRecoveryOperationLog(operation.id, cursor);
      setLog((previous) => previous + page.text);
      setCursor(page.nextCursor);
      setMore(page.more);
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }
  async function resolveRisk(action: 'reject' | 'release' | 'accept-and-continue'): Promise<void> {
    setBusy(true);
    try {
      await window.cloudhelm.resolveOperationRisk({ actionId: crypto.randomUUID(), action, operationId: operation.id,
        explanation: action === 'reject' ? REJECTION_EXPLANATION : RISK_EXPLANATION,
        sourceTaskId: conversation.id });
      if (action === 'reject') setDismissed(true);
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }
  if (dismissed) return <p role="status">已拒绝接管风险；主机写入仍被阻断。再次提交写入请求时可重新查看。</p>;
  return <Card as="section" tone="raised" className={styles.operationCard} role="region" aria-label="本次远端写入风险确认">
    <strong>本次写入暂未发送 · 待处理 1 / {remaining} 项</strong>
    <p>待执行：<code>{current?.preview ?? '当前对话请求的远端变更'}</code></p>
    {request && <p>用途：{request.slice(0, 120)}</p>}
    <p>风险：{operation.hostId === hostId ? '同一主机' : '同一风险域（含历史配置）'}的{operation.taskId === conversation.id ? '当前' : '历史'}对话有操作结果未确认；直接继续写入可能与其影响冲突。此项确认不会证明旧操作成功，也不会自动执行本次命令。</p>
    <details><summary>查看本次阻断项及原日志</summary>
      <p>阻断项 {operation.id}{source ? ` · 来源对话「${source.goal.slice(0, 80)}」` : ''}</p>
      {operation.hostId !== hostId && <p>原配置：{snapshot.hosts?.find((item) => item.id === operation.hostId)?.label ?? operation.hostId}。风险关联不代表当前连接已核验原操作。</p>}
      <pre className={styles.command}>{operation.preview}</pre>
      {operation.outputTail && <pre className={styles.outputTail}>{operation.outputTail.slice(-1600)}</pre>}
      {resolvable && <Button size="compact" disabled={busy} onClick={() => void readLog()}>{log ? '继续读取脱敏日志' : '读取脱敏日志'}</Button>}
      {log && <pre className={styles.outputTail}>{log.slice(-16_384)}</pre>}
      {log && !more && <small>日志已读完；输出本身不能证明命令退出或没有副作用。</small>}
    </details>
    {resolvable ? <div className={styles.cardActions}>
      <Button size="compact" disabled={busy} onClick={() => void resolveRisk('reject')}>拒绝，保持阻断</Button>
      <Button size="compact" disabled={busy} onClick={() => void resolveRisk('release')}>知晓风险，仅解除这条写入阻断</Button>
      <Button size="compact" disabled={busy} onClick={() => void resolveRisk('accept-and-continue')}>接受风险并继续对话</Button>
    </div> : <p>原操作仍在运行或审核中，不能解除；请等待真实退出。</p>}
    <small>风险确认不等于继续聊天。全部阻断项解除后，请点击对话顶部的「继续 AI」或发送消息；AI 不会自动重放原命令，新的命令仍须审核。</small>
  </Card>;
}

/** Show a single host-wide blocker only after this conversation encounters it. */
export function RecoveryCard({ snapshot, hostId, conversation, report }: {
  snapshot: AppSnapshot; hostId: string; conversation?: TaskView; report(error: string): void;
}): React.JSX.Element | null {
  if (!conversation) return null;
  const current = snapshot.operations.filter((item) => item.taskId === conversation.id && item.hostId === hostId
    && item.failureKind === 'unresolved-prior-operation').at(-1);
  if (!current && !snapshot.operations.some((item) => item.taskId === conversation.id && item.hostId === hostId
    && operationOutcomeResolvable(item))) return null;
  const blockers = snapshot.operations.filter((item) => sharesHostRiskDomain(snapshot.hostRiskBindings, item.hostId, hostId) && operationNeedsVerification(item));
  if (!blockers.length) return null;
  return <RecoveryItem key={`${blockers[0]!.id}:${current?.id ?? ''}`} operation={blockers[0]!} snapshot={snapshot}
    conversation={conversation} current={current} remaining={blockers.length} hostId={hostId} report={report} />;
}
