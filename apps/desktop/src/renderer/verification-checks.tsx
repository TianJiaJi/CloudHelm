import type { VerificationReport } from '@cloudhelm/contracts';
const labels = { passed: '通过', failed: '失败', inconclusive: '无法确定' };

/** Projection only: the backend decides report acceptance and verification state. */
export function VerificationChecks({ value }: { value?: VerificationReport }): React.JSX.Element | null {
  if (!value) return null;
  if (value.version !== 2) return <small>历史格式报告：未包含逐项检查，不自动赋予新版检查结论。</small>;
  return <details open><summary>检查项与未验证原因</summary>
    <small>检查登记验证证据归属与时序，不自动证明其语义相关性或完整业务成功。</small>
    <ol>{value.checks?.slice(0, 32).map((check, index) => <li key={index}>
      <strong>{labels[check.status]} · {check.target}</strong>
      <p>预期：{check.expected}</p><p>观察：{check.observed}</p>
      <small>变更：{check.changeOperationIds.join('、')} · 证据：{check.evidenceOperationIds.join('、') || '未取得'}</small>
    </li>)}</ol>
    {!!value.unverifiedChanges?.length && <ul>{value.unverifiedChanges.slice(0, 64).map((change) => <li key={change.operationId}>
      未验证 {change.operationId}：{change.reason}
    </li>)}</ul>}
  </details>;
}
