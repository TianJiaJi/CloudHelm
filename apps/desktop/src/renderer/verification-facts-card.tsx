import { useState } from 'react';
import type { TaskView, VerificationReport } from '@cloudhelm/contracts';
import { VerificationChecks } from './verification-checks.js';
import { capture, Icon } from './ui-helpers.js';
import { useUi } from './store.js';
import { copyEntries } from './clipboard.js';
import { openContextMenu } from './context-menu.js';
import { presentError } from './error-presentation.js';
import styles from './ui.module.css';
import layout from './verification-facts.module.css';

const execution = { none: '没有远端执行', succeeded: '操作已成功返回', 'succeeded-after-retry': '执行完成；未启动的尝试之后已有成功运行', failed: '有操作失败或被拒绝', unknown: '有执行结果尚未明确' };
const goals = { 'not-checked': '尚未取得目标检查，不等于执行失败', 'execution-observed': '运行检查通过，输出已记录；业务输出要求未独立比较', passed: '已登记的确定性检查通过', failed: '有已登记的检查失败',
  inconclusive: '部分目标证据不足，无法确定', 'model-assessed': '模型已作判断，未经后端确定性证明' };
const impact = { 'effect-free': '本轮操作被分类为无影响', 'not-assessed': '影响未独立评估，不否定已通过的目标检查',
  'risk-accepted': '用户已接管未知结果风险；接管不等于成功', unresolved: '仍有未决远端结果，须先核验原操作，禁止直接重放' };

/** Pure projection of backend-owned dimensions. No UI rule grants approval or clears a lock. */
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
  const warning = facts.goals === 'failed' || facts.goals === 'inconclusive' || facts.execution === 'failed'
    || facts.impact === 'risk-accepted' || facts.impact === 'unresolved';
  const failure = conversation.status === 'failed' ? presentError(conversation.summary) : undefined;
  const conclusion = [execution[facts.execution], goals[facts.goals], impact[facts.impact], value.summary].join('\n');
  return <section className={`${styles.reviewCard} ${styles.verificationCard} ${warning ? styles.verificationWarning : ''}`}
    role={warning ? 'alert' : undefined}
    onContextMenu={(event) => openContextMenu(event, copyEntries('复制结果与限制', conclusion, report), '执行与检查记录')}>
    <div className={styles.cardTitle}><Icon name={facts.goals === 'passed' && !warning ? 'check' : 'shield'} /><strong>执行与检查记录</strong>
      <small>{facts.registration === 'automatic' ? '后端自动整理' : '含模型补充'}</small></div>
    <dl className={layout.dimensions}>
      <dt>执行</dt><dd>{execution[facts.execution]}</dd>
      <dt>目标检查</dt><dd>{goals[facts.goals]}</dd>
      <dt>影响与风险</dt><dd>{impact[facts.impact]}</dd>
    </dl>
    <small>仅确认下列具体观察，不保证完整业务成功，也不证明没有其他影响。</small>
    <p>{value.summary}</p>
    {!!facts.unresolvedOperationIds.length && <p>未决操作：{facts.unresolvedOperationIds.join('、')}</p>}
    {!!facts.riskOperationIds.length && <p>已接管但结果仍未知的操作：{facts.riskOperationIds.join('、')}</p>}
    {!!facts.recoveredAttemptIds?.length && <details><summary>曾未启动、后续已有成功运行的尝试（{facts.recoveredAttemptIds.length}）</summary>
      <p>原尝试仍是未启动失败，不改写为成功；后续运行可能使用了不同工作目录。</p><code>{facts.recoveredAttemptIds.join('、')}</code></details>}
    {!!facts.uncheckedOperationIds.length && <details><summary>其他操作记录（{facts.uncheckedOperationIds.length}）</summary>
      <p>这些操作未单独比较业务结果，不等于失败，也不要求逐项补表或重放。具体状态见全部操作。</p><code>{facts.uncheckedOperationIds.join('、')}</code></details>}
    {facts.operations.some((op) => op.kind === 'write-file' || op.kind === 'upload') && !value.goalChecks?.some((check) => check.kind === 'file-content')
      && <p>本报告没有文件内容读回证据；ls 只能说明目录项，不能证明内容已核对。</p>}
    <VerificationChecks value={value} />
    {failure && <details><summary>{failure.title}</summary><pre>{failure.details}</pre></details>}
    <div className={styles.cardActions}>
      {conversation.status === 'answered' && facts.registration === 'automatic' && conversation.verificationRound?.closed
        && conversation.verificationRound.id === facts.roundId && <button title="只整理已有记录，不运行命令、不调用模型" disabled={rebuilding}
          onClick={() => void rebuild()}>{rebuilding ? '正在整理已有记录…' : '仅按已有记录重新整理'}</button>}
      <button onClick={() => useUi.getState().openReport(conversation.id)}>查看完整记录</button></div>
  </section>;
}

export function VerificationHistory({ values }: { values?: VerificationReport[] }): React.JSX.Element | null {
  if (!values?.length) return null;
  return <details><summary>此前报告与修订（最近 {values.length} 份）</summary>
    <small>新一轮对话不代表接受旧风险；完整修订已持久化，以下为最近记录。</small>
    {values.slice().reverse().map((value, index) => <article key={index}>
      <p>{value.summary}</p>{value.facts && <p>目标：{goals[value.facts.goals]}；影响：{impact[value.facts.impact]}</p>}
      <VerificationChecks value={value} />
    </article>)}
  </details>;
}
