import { useState } from 'react';
import { operationNeedsVerification, operationOutcomeResolvable, sharesHostRiskDomain, type AppSnapshot, type DiagnosisRestriction, type OperationView, type TaskView } from '@cloudhelm/contracts';
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
      <Button variant="primary" size="compact" disabled={busy} onClick={() => void resolveRisk('accept-and-continue')}>接受风险并继续对话</Button>
    </div> : <p>原操作仍在运行或审核中，不能解除；请等待真实退出。</p>}
    <small>选择「仅解除」不会续跑。「接受风险并继续」仅在后端确认可续跑时生效。原命令不会自动重放，新命令仍须审核。</small>
  </Card>;
}

function RecoveryReceipt({ operation }: { operation: OperationView }): React.JSX.Element {
  const decision = operation.recoveryDecision;
  const evidence = operation.reconciliation?.kind === 'evidence';
  return <p role="status">
    {evidence ? '原操作已按证据核验。' : '已记录风险接管；这不证明原操作成功。'}
    {' 此处置不代表本轮恢复写入；新的写入仍须通过安全检查。'}
    {!evidence && (decision?.error ? <> {decision.error}</> : decision?.resumed ? ' 已发起续跑。'
      : decision?.resumeNote ? <> 未自动续跑：{decision.resumeNote}</> : null)}
  </p>;
}

/** Display backend state without inferring that a reconciliation restores write permission. */
export function DiagnosisNotice({ reason, running }: { reason?: DiagnosisRestriction; running: boolean }): React.JSX.Element | null {
  if (!reason) return null;
  return <div className={styles.agentActivity} role="status">
    <strong>本轮仅限只读调查</strong>
    {' · '}{reason === 'user-denied' ? '有操作未获批准。' : '先前写入曾出现未确认的结果。'}
    {running ? ' AI 可以继续核验，不能发起新写入。等待本轮结束后可发送新消息。'
      : ' 如需继续，请发送新消息；若对话已暂停，也可使用「继续 AI」。'}
    {' 新一轮仍须遵守未解除的写锁及审核。'}
  </div>;
}

/** Show one pending blocker and the latest explicitly associated recovery receipt. */
export function RecoveryCard({ snapshot, hostId, conversation, report }: {
  snapshot: AppSnapshot; hostId: string; conversation?: TaskView; report(error: string): void;
}): React.JSX.Element | null {
  if (!conversation) return null;
  const current = snapshot.operations.filter((item) => item.taskId === conversation.id && item.hostId === hostId
    && item.failureKind === 'unresolved-prior-operation').at(-1);
  const domainOperations = snapshot.operations.filter((item) => sharesHostRiskDomain(snapshot.hostRiskBindings, item.hostId, hostId));
  const blockers = current || domainOperations.some((item) => item.taskId === conversation.id && item.hostId === hostId
    && operationOutcomeResolvable(item)) ? domainOperations.filter(operationNeedsVerification) : [];
  const receipt = domainOperations.filter((item) => item.reconciledAt && item.reconciliation
    && !operationNeedsVerification(item) && (item.reconciliation.kind === 'evidence'
      ? item.taskId === conversation.id && item.hostId === hostId
      : item.recoveryDecision?.sourceTaskId === conversation.id || (!item.recoveryDecision?.sourceTaskId
        && item.taskId === conversation.id && item.hostId === hostId)))
    .sort((a, b) => b.reconciledAt! - a.reconciledAt!)[0];
  const blocker = blockers[0];
  if (!receipt && !blocker) return null;
  return <>
    {receipt && <RecoveryReceipt operation={receipt} />}
    {blocker && <RecoveryItem key={`${blocker.id}:${current?.id ?? ''}`} operation={blocker} snapshot={snapshot}
      conversation={conversation} current={current} remaining={blockers.length} hostId={hostId} report={report} />}
  </>;
}
