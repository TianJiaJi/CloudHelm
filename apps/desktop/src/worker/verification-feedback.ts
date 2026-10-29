import { Value } from 'typebox/value';
import { VerificationCheckSchema, VerificationReportV2Schema, UnverifiedChangeSchema,
  type OperationView, type VerificationCheck, type VerificationReportV2 } from '@cloudhelm/contracts';

export interface VerificationIssue {
  code: string;
  guidance: string;
  path?: string;
  /** Backend-owned IDs only; never echo an arbitrary supplied/foreign identifier. */
  operationIds?: string[];
  omittedOperationIds?: number;
}
export interface VerificationFeedback {
  issues: VerificationIssue[];
  omittedIssues: number;
  repair?: ReturnType<typeof verificationRepair>;
}
export type IndexedObservation = { operation: OperationView; index: number };
export function eligibleObservation(entry: IndexedObservation | undefined): entry is IndexedObservation {
  return !!entry && entry.operation.kind === 'command' && entry.operation.readOnly === true
    && entry.operation.effects === 'none' && ['succeeded', 'failed'].includes(entry.operation.status)
    && Number.isInteger(entry.operation.exitCode) && entry.operation.exitCode! >= 0
    && entry.operation.reconciliation?.kind !== 'risk-accepted';
}
export const passedObservation = (entry: IndexedObservation) => entry.operation.status === 'succeeded' && entry.operation.exitCode === 0;
const boundedIds = (ids: string[]) => ({ operationIds: ids.slice(0, 64), omitted: Math.max(0, ids.length - 64) });

/** A bounded snapshot for repairing this report, not approval or semantic proof. */
export function verificationRepair(operations: OperationView[], covered: Set<string>) {
  const changes = operations.flatMap((operation, index) => operation.status === 'succeeded' && operation.readOnly !== true
    ? [{ operation, index }] : []);
  const latest = new Map(changes.map((entry) => [entry.operation.hostId, entry]));
  const eligible = operations.map((operation, index) => ({ operation, index })).filter((entry) => eligibleObservation(entry)
    && changes.some((target) => target.operation.hostId === entry.operation.hostId && target.index < entry.index));
  return {
    requiredChanges: boundedIds(changes.map((entry) => entry.operation.id)),
    uncoveredChanges: boundedIds(changes.filter((entry) => !covered.has(entry.operation.id)).map((entry) => entry.operation.id)),
    eligibleEvidence: boundedIds(eligible.map((entry) => entry.operation.id)),
    eligiblePassedEvidence: boundedIds(eligible.filter(passedObservation).map((entry) => entry.operation.id)),
    finalChecksByHost: [...latest.values()].slice(0, 16).map((last) => ({ hostId: last.operation.hostId,
      lastChangeOperationId: last.operation.id, ...boundedIds(eligible.filter((entry) => passedObservation(entry)
        && entry.operation.hostId === last.operation.hostId && entry.index > last.index).map((entry) => entry.operation.id)) })),
    omittedHosts: Math.max(0, latest.size - 16)
  };
}
export function verificationRejected(issues: VerificationIssue[], repair?: ReturnType<typeof verificationRepair>) {
  const first = issues[0]!;
  const feedback = { accepted: false as const, code: first.code,
    guidance: `${first.guidance} 请一次修正issues中列出的全部问题；repair仅为本轮索引，提交时重新核验。不要重放成功操作凑证据。`,
    issues: issues.slice(0, 64).map((issue) => ({ ...issue, ...(issue.operationIds ? { operationIds: [...issue.operationIds] } : {}) })),
    omittedIssues: Math.max(0, issues.length - 64), ...(repair ? { repair: structuredClone(repair) } : {}) };
  const oversized = () => Buffer.byteLength(JSON.stringify(feedback), 'utf8') > 24_576;
  while (oversized() && feedback.issues.length > 1) { feedback.issues.pop(); feedback.omittedIssues++; }
  if (feedback.repair) {
    const hints = feedback.repair;
    for (const list of [hints.eligibleEvidence, hints.eligiblePassedEvidence, ...hints.finalChecksByHost,
      hints.requiredChanges, hints.uncoveredChanges]) {
      while (oversized() && list.operationIds.length) { list.operationIds.pop(); list.omitted++; }
    }
    while (oversized() && hints.finalChecksByHost.length) { hints.finalChecksByHost.pop(); hints.omittedHosts++; }
  }
  for (const issue of feedback.issues) {
    while (oversized() && issue.operationIds?.length) { issue.operationIds.pop(); issue.omittedOperationIds = (issue.omittedOperationIds ?? 0) + 1; }
  }
  return feedback;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rootKeys = Object.keys(VerificationReportV2Schema.properties);
/** Inspect only shared-schema paths, never include user prose, unknown keys or native validation errors. */
export function inspectVerificationShape(value: unknown, issues: VerificationIssue[]) {
  const valid = Value.Check(VerificationReportV2Schema, value);
  const root = object(value) ? value : {};
  if (!valid) {
    for (const key of rootKeys) {
      const schema = VerificationReportV2Schema.properties[key as keyof VerificationReportV2];
      if (!Value.Check(schema, root[key])) issues.push({ code: 'verification-fields-invalid', path: `/${key}`,
        guidance: root[key] === undefined ? `${key}是必填字段；checks和unverifiedChanges无条目时也须传[]。`
          : `${key}不符合工具公布的类型、长度或数量限制。` });
    }
    if (Object.keys(root).some((key) => !rootKeys.includes(key))) issues.push({ code: 'verification-fields-invalid', path: '/', guidance: '报告含未定义字段，请仅使用工具schema中的字段。' });
  }
  const checks: Array<{ value: VerificationCheck; index: number }> = [];
  const unverified: VerificationReportV2['unverifiedChanges'] = [];
  if (Array.isArray(root.checks)) root.checks.slice(0, 32).forEach((item, index) => {
    if (Value.Check(VerificationCheckSchema, item)) checks.push({ value: item, index });
    else {
      for (const [key, schema] of Object.entries(VerificationCheckSchema.properties)) {
        if (!object(item) || !Value.Check(schema, item[key])) issues.push({ code: 'verification-fields-invalid', path: `/checks/${index}/${key}`, guidance: `检查项的${key}类型、长度或数量无效。` });
      }
      if (object(item) && Object.keys(item).some((key) => !Object.hasOwn(VerificationCheckSchema.properties, key))) {
        issues.push({ code: 'verification-fields-invalid', path: `/checks/${index}`, guidance: '检查项含未定义字段，请仅使用工具schema中的字段。' });
      }
    }
  });
  if (Array.isArray(root.unverifiedChanges)) root.unverifiedChanges.slice(0, 64).forEach((item, index) => {
    if (Value.Check(UnverifiedChangeSchema, item)) unverified.push(item);
    else issues.push({ code: 'verification-fields-invalid', path: `/unverifiedChanges/${index}`, guidance: '未验证项须只含operationId和非空reason，并遵守长度限制。' });
  });
  return { valid, report: valid ? value as VerificationReportV2 : undefined, checks, unverified };
}
