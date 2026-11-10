import { useState } from 'react';
import type { TaskView, VerificationReport } from '@cloudhelm/contracts';
import { VerificationChecks } from './verification-checks.js';
import { capture, Icon } from './ui-helpers.js';
import { useUi } from './store.js';
import { copyEntries } from './clipboard.js';
import { openContextMenu } from './context-menu.js';
import styles from './ui.module.css';

const operationStatus: Readonly<Record<string, string>> = { succeeded: '执行返回', failed: '执行失败', denied: '已拦截', unknown: '结果未知',
  proposed: '待审核', approved: '已批准，待执行', running: '执行中' };

/** Evidence only, opened deliberately. Never infer an overall verdict from a
 * plan, an exit code, a missing report field, or a model-authored comparison. */
export function VerificationFactsCard({ conversation, value, report }: {
  conversation: TaskView; value: VerificationReport; report(error: string): void;
}): React.JSX.Element {
  const facts = value.facts!;
  const [rebuilding, setRebuilding] = useState(false);
  const rebuild = async () => {
    setRebuilding(true);
    try { await capture(() => window.cloudhelm.rebuildVerificationReport(conversation.id), report); }
    finally { setRebuilding(false); }
  };
  const record = facts.operations.map((op) => `${op.operationId}: ${operationStatus[op.status] ?? '状态未登记'}${op.exitCode === undefined ? '' : ` (exit ${op.exitCode})`}`).join('\n');
  return <section className={`${styles.reviewCard} ${styles.verificationCard}`} aria-label="执行证据"
    onContextMenu={(event) => openContextMenu(event, copyEntries('复制执行记录', record, report), '执行证据')}>
    <div className={styles.cardTitle}><Icon name="history" /><strong>执行证据</strong></div>
    {!!facts.unresolvedOperationIds.length && <p role="alert">以下操作的结果尚未确认：{facts.unresolvedOperationIds.join('、')}。请先核对原操作，不要直接重试。</p>}
    {!!facts.riskOperationIds.length && <p>已接管风险的操作：{facts.riskOperationIds.join('、')}。原结果仍未知。</p>}
    <details><summary>操作记录（{facts.operations.length}）</summary><pre>{record || '没有远端操作记录'}</pre></details>
    {!!facts.recoveredAttemptIds?.length && <details><summary>已恢复的早期尝试（{facts.recoveredAttemptIds.length}）</summary>
      <code>{facts.recoveredAttemptIds.join('、')}</code></details>}
    <VerificationChecks value={value} />
    {conversation.status === 'answered' && facts.registration === 'automatic' && conversation.verificationRound?.closed
      && conversation.verificationRound.id === facts.roundId && <div className={styles.cardActions}>
        <button title="只整理已有记录，不运行命令、不调用模型" disabled={rebuilding}
          onClick={() => void rebuild()}>{rebuilding ? '正在整理已有记录…' : '仅按已有记录重新整理'}</button>
        <button onClick={() => useUi.getState().openReport(conversation.id)}>查看完整记录</button>
      </div>}
  </section>;
}

export function VerificationHistory({ values }: { values?: VerificationReport[] }): React.JSX.Element | null {
  if (!values?.length) return null;
  return <details><summary>历史记录与修订（最近 {values.length} 份）</summary>
    {values.slice().reverse().map((value, index) => <article key={index}>
      <p>{value.summary}</p>
      {!!value.facts?.riskOperationIds.length && <p>风险接管记录：{value.facts.riskOperationIds.join('、')}</p>}
      <VerificationChecks value={value} />
    </article>)}
  </details>;
}
