import { Value } from 'typebox/value';
import { operationNeedsVerification, VerificationReportV2Schema, type OperationView, type VerificationReportV2,
  type VerificationReason } from '@cloudhelm/contracts';
import { mergeOperationViews } from './runtime-facts.js';
import { hasJournalCredentials } from './journal-secrets.js';

type Validation = { accepted: true; report: VerificationReportV2; reason?: Exclude<VerificationReason, 'report-missing'> }
  | { accepted: false; code: string; guidance: string };
const reject = (code: string, guidance: string): Validation => ({ accepted: false, code, guidance });
const unique = (ids: string[]) => new Set(ids).size === ids.length;

/** Structural evidence checks only; relevant application semantics still require
 * honest model/user judgment. No execution, approval, replay or lock resolution. */
export function validateVerificationV2(taskId: string, value: unknown, round: OperationView[], all: OperationView[]): Validation {
  if (!Value.Check(VerificationReportV2Schema, value)) return reject('verification-fields-invalid', '报告版本或有界检查项格式无效，请使用version=2及checks/unverifiedChanges。');
  const report = value;
  const texts = [report.summary, ...report.access, ...report.changes, ...report.recovery,
    ...report.checks.flatMap((check) => [check.target, check.expected, check.observed]), ...report.unverifiedChanges.map((item) => item.reason)];
  if (texts.some((text) => !text.trim())) return reject('verification-fields-missing', '检查目标、预期、观察和未验证原因均须有实质说明。');
  if (texts.some(hasJournalCredentials)) return reject('verification-secret', '报告可能含敏感信息，未保存；请移除凭据后再提交。');
  const operations = mergeOperationViews(round).filter((op) => op.taskId === taskId);
  if (mergeOperationViews(all).filter((op) => op.taskId === taskId).some(operationNeedsVerification))
    return reject('verification-outcome-unresolved', '仍有未决结果，先核验原操作；报告不能解除结果锁。');
  const indexed = new Map(operations.map((operation, index) => [operation.id, { operation, index }]));
  const changes = operations.filter((op) => op.status === 'succeeded' && op.readOnly !== true);
  if (!changes.length) return reject('verification-no-changes', '当前轮次没有需登记的成功操作；只读诊断直接回答即可。');
  const changedIds = new Set(changes.map((op) => op.id));
  const latest = new Map(changes.map((op) => [op.hostId, indexed.get(op.id)!.index]));
  const covered = new Set<string>(); const finalHosts = new Set<string>(); const evidenceIds = new Set<string>();
  let failed = false, inconclusive = false;
  for (const check of report.checks) {
    if (!unique(check.changeOperationIds) || !unique(check.evidenceOperationIds)
      || check.changeOperationIds.some((id) => !changedIds.has(id)))
      return reject('verification-change-invalid', '检查必须绑定本轮真实变更ID，且每组ID不能重复。');
    if (check.status !== 'inconclusive' && !check.evidenceOperationIds.length)
      return reject('verification-evidence-invalid', 'passed/failed需要真实只读观察；未取得证据应使用inconclusive并解释。');
    const evidence = check.evidenceOperationIds.map((id) => indexed.get(id));
    const eligible = (entry: typeof evidence[number]) => entry && entry.operation.kind === 'command' && entry.operation.readOnly === true
      && entry.operation.effects === 'none' && ['succeeded', 'failed'].includes(entry.operation.status)
      && Number.isInteger(entry.operation.exitCode) && entry.operation.exitCode! >= 0
      && entry.operation.reconciliation?.kind !== 'risk-accepted';
    if (evidence.some((entry) => !eligible(entry) || (check.status === 'passed'
      && (entry!.operation.status !== 'succeeded' || entry!.operation.exitCode !== 0))))
      return reject('verification-evidence-invalid', '证据需属于本对话、本轮、真实退出的effect-free检查；passed还要求成功且exit=0。');
    const targets = check.changeOperationIds.map((id) => indexed.get(id)!);
    if (evidence.some((entry) => !targets.some((target) => target.operation.hostId === entry!.operation.hostId && target.index < entry!.index))
      || (check.status !== 'inconclusive' && targets.some((target) => !evidence.some((entry) => entry!.operation.hostId === target.operation.hostId && entry!.index > target.index))))
      return reject('verification-evidence-order', '证据必须对应目标主机并晚于所登记变更；跨主机、旧检查或无关ID不可代替。');
    for (const target of check.changeOperationIds) covered.add(target);
    for (const entry of evidence) {
      evidenceIds.add(entry!.operation.id);
      if (check.status === 'passed' && entry!.index > latest.get(entry!.operation.hostId)!) finalHosts.add(entry!.operation.hostId);
    }
    failed ||= check.status === 'failed'; inconclusive ||= check.status === 'inconclusive';
  }
  if (!unique(report.unverifiedChanges.map((item) => item.operationId)) || report.unverifiedChanges.some((item) => !changedIds.has(item.operationId)))
    return reject('verification-change-invalid', '未验证原因只能绑定本轮真实变更ID，且不得重复。');
  for (const item of report.unverifiedChanges) covered.add(item.operationId);
  if (changes.some((op) => !covered.has(op.id))) return reject('verification-changes-uncovered', '每个本轮变更都需要关联检查或明确的未验证原因。');
  if (!unique(report.evidenceOperationIds) || report.evidenceOperationIds.length !== evidenceIds.size
    || report.evidenceOperationIds.some((id) => !evidenceIds.has(id)))
    return reject('verification-evidence-index', '顶层证据ID必须恰好是各检查引用ID的去重并集，不能添入额外或未知证据。');
  const reason = failed ? 'checks-failed' : inconclusive ? 'checks-inconclusive' : report.unverifiedChanges.length ? 'changes-unverified' : undefined;
  if (!reason && [...latest.keys()].some((hostId) => !finalHosts.has(hostId))) {
    const eligibleIds = operations.filter((op, i) => op.readOnly === true && op.status === 'succeeded' && op.exitCode === 0
      && op.effects === 'none' && latest.has(op.hostId) && i > latest.get(op.hostId)!).slice(-8).map((op) => op.id);
    return reject('verification-evidence-order', `每个变更主机都需最后变更之后的成功检查；请复用已有ID：${eligibleIds.join(', ') || '暂无'}，不得重放变更。`);
  }
  return { accepted: true, report: structuredClone(report), reason };
}
