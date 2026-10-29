import { operationNeedsVerification, type OperationView, type VerificationReportV2, type VerificationReason } from '@cloudhelm/contracts';
import { mergeOperationViews } from './runtime-facts.js';
import { hasJournalCredentials } from './journal-secrets.js';
import { eligibleObservation, inspectVerificationShape, passedObservation, verificationRejected, verificationRepair,
  type VerificationIssue } from './verification-feedback.js';

type Validation = { accepted: true; report: VerificationReportV2; reason?: Exclude<VerificationReason, 'report-missing'> }
  | ReturnType<typeof verificationRejected>;
const unique = (ids: string[]) => new Set(ids).size === ids.length;

/** Aggregate independently detectable problems, without repairing assertions,
 * weakening evidence, executing operations or clearing an outcome lock. */
export function validateVerificationV2(taskId: string, value: unknown, round: OperationView[], all: OperationView[]): Validation {
  const issues: VerificationIssue[] = [];
  const shape = inspectVerificationShape(value, issues);
  const report = shape.report;
  if (report) {
    const fields: Array<[string, string]> = [['/summary', report.summary],
      ...(['access', 'changes', 'recovery'] as const).flatMap((key) => report[key].map((text, index): [string, string] => [`/${key}/${index}`, text])),
      ...report.checks.flatMap((check, index) => (['target', 'expected', 'observed'] as const).map((key): [string, string] => [`/checks/${index}/${key}`, check[key]])),
      ...report.unverifiedChanges.map((item, index): [string, string] => [`/unverifiedChanges/${index}/reason`, item.reason])];
    if (fields.some(([, text]) => hasJournalCredentials(text))) return verificationRejected([{ code: 'verification-secret', guidance: '报告可能含敏感信息，未保存；请移除凭据后再提交。' }]);
    for (const [path, text] of fields) if (!text.trim()) issues.push({ code: 'verification-fields-missing', path, guidance: '此字段须有实质说明，不能只含空白；不适用时应明确写出。' });
  }
  const operations = mergeOperationViews(round).filter((op) => op.taskId === taskId);
  const unresolved = mergeOperationViews(all).filter((op) => op.taskId === taskId && operationNeedsVerification(op));
  if (unresolved.length) issues.push({ code: 'verification-outcome-unresolved', guidance: '仍有未决结果，先核验原操作；报告不能解除结果锁。', operationIds: unresolved.slice(0, 64).map((op) => op.id) });
  const indexed = new Map(operations.map((operation, index) => [operation.id, { operation, index }]));
  const changes = operations.filter((op) => op.status === 'succeeded' && op.readOnly !== true);
  if (!changes.length) issues.push({ code: 'verification-no-changes', guidance: '当前轮次没有需登记的成功操作；只读诊断直接回答即可。' });
  const changedIds = new Set(changes.map((op) => op.id));
  const latest = new Map(changes.map((op) => [op.hostId, indexed.get(op.id)!.index]));
  const covered = new Set<string>(); const finalHosts = new Set<string>(); const evidenceIds = new Set<string>();
  let failed = false, inconclusive = false;
  for (const { value: check, index } of shape.checks) {
    const path = `/checks/${index}`;
    const targets = check.changeOperationIds.flatMap((id) => changedIds.has(id) ? [indexed.get(id)!] : []);
    if (!unique(check.changeOperationIds) || !unique(check.evidenceOperationIds) || targets.length !== check.changeOperationIds.length) {
      issues.push({ code: 'verification-change-invalid', path, guidance: '检查只能绑定本轮成功且未证明只读的操作ID；每组变更ID和证据ID均不可重复。' });
    }
    for (const target of targets) covered.add(target.operation.id);
    if (check.status !== 'inconclusive' && !check.evidenceOperationIds.length) issues.push({
      code: 'verification-evidence-invalid', path: `${path}/evidenceOperationIds`, guidance: 'passed/failed需要真实只读观察；未取得证据应使用inconclusive并解释。' });
    const evidence = check.evidenceOperationIds.map((id) => indexed.get(id));
    const qualified = evidence.filter((entry) => eligibleObservation(entry) && (check.status !== 'passed' || passedObservation(entry)));
    evidence.forEach((entry, evidenceIndex) => {
      if (!eligibleObservation(entry) || check.status === 'passed' && !passedObservation(entry)) issues.push({
        code: 'verification-evidence-invalid', path: `${path}/evidenceOperationIds/${evidenceIndex}`,
        guidance: '所有状态的证据均须为本对话、本轮、已真实退出的effect-free检查；passed另须成功且exit=0。未分类的脚本运行不可引用为证据，可在observed如实描述、使用inconclusive和空证据。',
        ...(entry ? { operationIds: [entry.operation.id] } : {}) });
    });
    if (qualified.length === evidence.length && evidence.length && targets.length === check.changeOperationIds.length
      && (qualified.some((entry) => !targets.some((target) => target.operation.hostId === entry!.operation.hostId && target.index < entry!.index))
        || check.status !== 'inconclusive' && targets.some((target) => !qualified.some((entry) => entry!.operation.hostId === target.operation.hostId && entry!.index > target.index)))) {
      issues.push({ code: 'verification-evidence-order', path, guidance: '证据必须对应目标主机并晚于所登记变更；跨主机、旧检查或无关ID不可代替。' });
    }
    for (const id of check.evidenceOperationIds) evidenceIds.add(id);
    for (const entry of qualified) {
      if (check.status === 'passed' && entry!.index > latest.get(entry!.operation.hostId)!) finalHosts.add(entry!.operation.hostId);
    }
    failed ||= check.status === 'failed'; inconclusive ||= check.status === 'inconclusive';
  }
  if (!unique(shape.unverified.map((item) => item.operationId)) || shape.unverified.some((item) => !changedIds.has(item.operationId))) {
    issues.push({ code: 'verification-change-invalid', path: '/unverifiedChanges', guidance: '未验证原因只能绑定本轮真实变更ID，且不得重复。' });
  }
  for (const item of shape.unverified) if (changedIds.has(item.operationId)) covered.add(item.operationId);
  const uncovered = changes.filter((op) => !covered.has(op.id));
  if (uncovered.length) issues.push({ code: 'verification-changes-uncovered', path: '/checks', operationIds: uncovered.slice(0, 64).map((op) => op.id),
    guidance: '以下操作尚未登记：每项均须关联检查或写入unverifiedChanges。成功但未判为只读的脚本试运行也需要登记，不等于已证明发生写入。' });
  if (report && (!unique(report.evidenceOperationIds) || report.evidenceOperationIds.length !== evidenceIds.size
    || report.evidenceOperationIds.some((id) => !evidenceIds.has(id)))) issues.push({
      code: 'verification-evidence-index', path: '/evidenceOperationIds', guidance: '顶层证据ID必须恰好是各检查引用ID的去重并集，不能添入额外或未知证据。' });
  const reason = failed ? 'checks-failed' : inconclusive ? 'checks-inconclusive' : shape.unverified.length ? 'changes-unverified' : undefined;
  if (!reason && [...latest.keys()].some((hostId) => !finalHosts.has(hostId))) issues.push({
    code: 'verification-evidence-order', guidance: '每个变更主机都需最后变更之后的成功检查；可用ID见repair.finalChecksByHost。若条件不足应如实登记未验证，不得重放变更。' });
  if (issues.length) return verificationRejected(issues, verificationRepair(operations, covered));
  // A partial diagnostic projection is never enough to accept a malformed report.
  if (!shape.valid || !report) return verificationRejected([{ code: 'verification-fields-invalid', guidance: '报告必须符合工具公布的version=2完整schema。' }]);
  return { accepted: true, report: structuredClone(report), reason };
}
