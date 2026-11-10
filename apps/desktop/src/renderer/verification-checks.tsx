import type { VerificationReport } from '@cloudhelm/contracts';
const labels = { passed: '通过', failed: '失败', inconclusive: '无法确定' };
const comparisons = { passed: '匹配', failed: '不匹配', inconclusive: '无法比较' };

/** Specific observations, never a second overall task-completion verdict. */
export function VerificationChecks({ value }: { value?: VerificationReport }): React.JSX.Element | null {
  if (!value) return null;
  if (value.version === 3) return value.goalChecks?.length ? <details><summary>具体检查（{value.goalChecks.length}）</summary>
    <ol>{value.goalChecks?.map((check, index) => <li key={index}>
      <strong>{check.authority === 'model' ? '模型判断' : check.kind === 'run-completion' ? '执行观察' : '规则比较'}：{check.authority !== 'model' && check.kind !== 'run-completion' ? comparisons[check.status] : labels[check.status]} · {check.target}</strong>
      {check.authority === 'model' && <small>此项是模型解释，不是后端确定性证明。</small>}
      <details><summary>预期、观察与来源</summary>{check.expectationSource && <small>{check.expectationSource === 'before-execution' ? '预期已在执行前声明' : '预期来自事后报告'}</small>}<pre>预期：{check.expected}</pre><pre>观察：{check.observed}</pre>
        <small>操作：{check.operationIds.join('、')}</small></details>
    </li>)}</ol>
    {!!value.unverifiedChanges?.length && <ul>{value.unverifiedChanges.map((item) => <li key={item.operationId}>未验证 {item.operationId}：{item.reason}</li>)}</ul>}
  </details> : null;
  if (value.version !== 2) return <small>历史格式报告：未包含逐项检查，不自动赋予新版检查结论。</small>;
  return <details open><summary>检查项与未验证原因</summary>
    <small>检查登记验证证据归属与时序，不自动证明其语义相关性或完整业务成功。</small>
    <ol>{value.checks?.slice(0, 32).map((check, index) => <li key={index}>
      <strong>历史模型判断：{labels[check.status]} · {check.target}</strong>
      <p>预期：{check.expected}</p><p>观察：{check.observed}</p>
      <small>变更：{check.changeOperationIds.join('、')} · 证据：{check.evidenceOperationIds.join('、') || '未取得'}</small>
    </li>)}</ol>
    {!!value.unverifiedChanges?.length && <ul>{value.unverifiedChanges.slice(0, 64).map((change) => <li key={change.operationId}>
      未验证 {change.operationId}：{change.reason}
    </li>)}</ul>}
  </details>;
}
