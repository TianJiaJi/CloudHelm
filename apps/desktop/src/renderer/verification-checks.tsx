import type { VerificationReport } from '@cloudhelm/contracts';
const labels = { passed: '通过', failed: '失败', inconclusive: '无法确定' };

/** Projection only: the backend decides report acceptance and verification state. */
export function VerificationChecks({ value }: { value?: VerificationReport }): React.JSX.Element | null {
  if (!value) return null;
  if (value.version === 3) return <details open><summary>运行观察与目标检查</summary>
    <small>运行完成不等于输出内容符合业务要求。输出预期可在执行前声明；文件读回须有独立内容证据。</small>
    {!value.goalChecks?.length && <p>尚未登记目标检查；执行事实已保留，不会为补报告自动重试。</p>}
    <ol>{value.goalChecks?.map((check, index) => <li key={index}>
      <strong>{check.authority === 'model' ? '模型判断' : check.kind === 'run-completion' ? '执行观察' : '规则比较'}：{labels[check.status]} · {check.target}</strong>
      <details><summary>预期、观察与来源</summary>{check.expectationSource && <small>{check.expectationSource === 'before-execution' ? '预期已在执行前声明' : '预期来自事后报告'}</small>}<pre>预期：{check.expected}</pre><pre>观察：{check.observed}</pre>
        <small>操作：{check.operationIds.join('、')}</small></details>
    </li>)}</ol>
    {!!value.unverifiedChanges?.length && <ul>{value.unverifiedChanges.map((item) => <li key={item.operationId}>未验证 {item.operationId}：{item.reason}</li>)}</ul>}
  </details>;
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
