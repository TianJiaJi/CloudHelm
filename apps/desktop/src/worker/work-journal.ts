import { Type, type Static } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';
import type { AppEvent, OperationView, VerificationReport } from '@cloudhelm/contracts';
import { operationNeedsVerification, VerificationSubmissionV3Schema, type VerificationReason,
  type VerificationSubmissionV3, type VerificationFacts, type GoalCheck } from '@cloudhelm/contracts';
import { validateSubmissionV3 } from './verification-submission.js';
import { buildVerificationReport, evaluateRunOutput, verificationReason } from './verification-facts.js';
import type { VerificationFeedback } from './verification-feedback.js';
import { validateVerificationV2 } from './verification-report-v2.js';
import { createReconciliationTool } from './reconciliation-tool.js';
import { mergeOperationViews } from './runtime-facts.js';
import { hasJournalCredentials } from './journal-secrets.js';
import { createOperationLogTool } from './operation-log-tool.js';
import type { LogPage } from '@cloudhelm/contracts/runtime';
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], details: undefined, isError });

/** Report fields are persisted verbatim; reject recognizable secrets before emitting an event. */
function reportHasCredentials(value: VerificationReport): boolean {
  return [value.summary, ...value.access, ...value.changes, ...value.recovery].some(hasJournalCredentials);
}

/** Structured progress and evidence are authoritative; prose alone cannot mark work verified. */
export class WorkJournal {
  private report?: VerificationReport;
  private reportReason?: Exclude<VerificationReason, 'report-missing'>;
  private reportIssue?: { code: string; guidance: string };
  private submission?: VerificationSubmissionV3;
  private notes?: VerificationReport;
  private failures = 0;
  private revision = 0;
  constructor(private readonly taskId: string, private readonly operations: () => OperationView[],
    private readonly emit: (event: AppEvent) => void,
    private readonly readLog: (operationId: string, cursor: number) => Promise<LogPage>,
    private readonly reconcile: (operation: OperationView) => boolean = () => false,
    private readonly reconciled: (operation: OperationView) => void = () => {},
    private readonly verificationOperations: () => OperationView[] = operations,
    private readonly roundId: () => string = () => taskId, initialReport?: VerificationReport) {
    this.report = initialReport ? structuredClone(initialReport) : undefined;
    this.notes = initialReport?.facts?.registration === 'automatic' ? undefined : this.report;
    this.submission = this.report?.expectations;
    this.revision = initialReport?.facts?.revision ?? 0;
    if (this.report?.facts) this.reportReason = verificationReason(this.report) as Exclude<VerificationReason, 'report-missing'> | undefined;
  }

  resetReport(): void {
    this.report = undefined; this.reportReason = undefined;
    this.reportIssue = undefined; this.submission = undefined; this.notes = undefined; this.failures = 0; this.revision = 0;
    this.emit({ type: 'work-report', taskId: this.taskId });
  }
  hasReport(): boolean { return !!this.report; }
  submissionClosed(): boolean { return this.failures >= 2; }
  /** Always assemble backend facts at completion, even if the model never submitted a report. */
  finalize(roundId: string): VerificationReport | undefined {
    const round = this.verificationOperations().filter((op) => op.taskId === this.taskId);
    if (!round.length || !this.report && round.every((op) => op.readOnly === true && !op.outputExpectation || op.status === 'denied')) return undefined;
    const checks: GoalCheck[] = this.submission ? (this.submission.checks ?? []).flatMap((check) => {
      const id = check.kind === 'run-output' ? check.operationId : check.evidenceOperationId;
      const operation = round.find((op) => op.id === id);
      if (!operation) return [];
      return check.kind === 'run-output' ? [evaluateRunOutput(operation, check)] : [{ kind: 'model-assessment' as const,
        authority: 'model' as const, target: check.target, expected: check.expected, observed: check.observed,
        status: check.status, operationIds: [id] }];
    }) : (this.notes?.checks ?? []).map((check) => ({ kind: 'model-assessment', authority: 'model',
      target: check.target, expected: check.expected, observed: check.observed, status: check.status,
      operationIds: [...check.changeOperationIds, ...check.evidenceOperationIds] }));
    const report = buildVerificationReport({ roundId, revision: this.revision, operations: round,
      all: this.operations().filter((op) => op.taskId === this.taskId), submitted: this.notes, checks });
    if (this.submission) report.expectations = structuredClone(this.submission);
    if (JSON.stringify(report) === JSON.stringify(this.report)) return this.report;
    report.facts!.revision = ++this.revision;
    this.report = report;
    this.reportReason = verificationReason(report) as Exclude<VerificationReason, 'report-missing'> | undefined;
    this.emit({ type: 'work-report', taskId: this.taskId, report: structuredClone(this.report) });
    return this.report;
  }
  completionReport(): { reportStatus?: 'verified' | 'unverified'; reportUnverifiedReason?: VerificationReason; reportFacts?: VerificationFacts } {
    return this.report ? { reportStatus: this.reportReason ? 'unverified' : 'verified', reportUnverifiedReason: this.reportReason,
      ...(this.report.facts ? { reportFacts: this.report.facts } : {}) } : {};
  }
  lastReportIssue(): { code: string; guidance: string } | undefined { return this.reportIssue; }
  private rejected(code: string, guidance: string, feedback?: VerificationFeedback) {
    if (this.submissionClosed()) guidance += ' 本轮不再要求修正报告；请直接说明已有结果与限制，后端会自动生成基础报告，不要重放操作。';
    this.reportIssue = { code, guidance };
    return result(JSON.stringify({ ...this.reportIssue, ...(feedback ? {
      issues: feedback.issues, omittedIssues: feedback.omittedIssues, repair: feedback.repair
    } : {}) }), true);
  }

  tools() {
    const planParameters = Type.Object({ steps: Type.Array(Type.Object({ id: Type.String(), title: Type.String(),
      status: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('done'), Type.Literal('blocked')]) }), { minItems: 1, maxItems: 20 }) });
    const plan: BusinessTool<Static<typeof planParameters>> = {
      name: 'update_plan', label: 'Update the visible work plan', replay: 'never', parameters: planParameters,
      description: 'For genuinely multi-step or uncertain work, publish concise plan steps and current progress in the user language. Skip for simple queries and short file operations. This does not execute or authorize anything.',
      execute: async (_id, { steps }) => {
        if (new Set(steps.map((step) => step.id)).size !== steps.length || steps.some((step) => !step.title.trim())) return result('Invalid plan', true);
        this.emit({ type: 'work-progress', taskId: this.taskId, plan: steps });
        return result('Plan updated');
      }
    };
    // New model calls use the exact backend schema; legacy records/direct replay
    // remain readable below but are not advertised as a new submission format.
    const reportParameters = VerificationSubmissionV3Schema;
    const report: BusinessTool<VerificationReport> = {
      name: 'submit_verification', label: 'Record change checks and uncertainty', replay: 'never', parameters: reportParameters,
      description: 'Optional report notes, not a completion gate. Prefer version=3: summary/recovery/checks are optional; backend assembles operation coverage and evidence indexes. run-output(operationId,expectedOutput,expectedExitCode=0) compares complete captured output exactly (CRLF normalized), independently of side effects; use the actual expected output including newline. model-assessment(target,expected,observed,evidenceOperationId,status) records your interpretation of an effect-free observation, NOT backend proof. File content read-back is matched automatically by host/path/hash. Expectations are model proposals, not proof of the entire user goal. Never execute or replay commands merely to complete a report. After a rejection correct once at most, then answer honestly; backend still creates a basic report. Unknown-result locks remain independent. No credentials. Legacy reports remain readable as model assessments, not backend proof.',
      execute: async (_id, value) => {
        if (value.version === 3) {
          if (this.submissionClosed()) return result('Report submission closed after two rejected attempts. Answer from existing observations; backend will assemble facts. No operation was executed and no outcome lock was cleared.');
          if (this.submission) return result('Notes already recorded for this round. Answer from the recorded results; do not replace expectations merely to obtain a passing label.');
          const validation = validateSubmissionV3(this.taskId, value, this.verificationOperations(), this.operations());
          if (!validation.accepted) { this.failures++; return this.rejected(validation.code, validation.guidance); }
          this.submission = validation.submission;
          this.report = { version: 3, summary: validation.submission.summary ?? '已登记目标观察。',
            recovery: validation.submission.recovery ?? [], access: [], changes: [], evidenceOperationIds: [] };
          this.notes = this.report;
          this.reportIssue = undefined;
          this.finalize(this.roundId());
          return result('Notes recorded. Backend will evaluate recorded goals and generate the report at completion; execution, goals and impact are separate. Do not resubmit to manufacture success.');
        }
        if (this.submission) return this.rejected('verification-format-downgrade', '已有新版目标观察，不能用旧报告覆盖；请说明已有结果。');
        if (value.version !== undefined || value.checks !== undefined || value.unverifiedChanges !== undefined) {
          const validation = validateVerificationV2(this.taskId, value, this.verificationOperations(), this.operations());
          if (!validation.accepted) return this.rejected(validation.code, validation.guidance, validation);
          this.report = validation.report; this.notes = this.report; this.reportReason = validation.reason; this.reportIssue = undefined;
          this.emit({ type: 'work-report', taskId: this.taskId, report: structuredClone(validation.report) });
          return result(validation.reason ? 'Checks recorded as unverified; explain failed/inconclusive results without replay.' : 'Checks recorded; conclusions remain limited to the cited observations.');
        }
        if (this.report?.version === 2) return this.rejected('verification-format-downgrade', '已有逐项检查报告，不能用旧格式覆盖其失败或未验证状态。');
        const operations = mergeOperationViews(this.verificationOperations()).filter((operation) => operation.taskId === this.taskId);
        const indexed = new Map(operations.map((operation, index) => [operation.id, { operation, index }]));
        const changes = operations.flatMap((operation, index) => operation.status === 'succeeded' && operation.readOnly !== true
          ? [{ operation, index }] : []);
        const latestByHost = new Map(changes.map(({ operation, index }) => [operation.hostId, index]));
        const evidence = value.evidenceOperationIds.map((id) => indexed.get(id));
        // Earlier successful checks stay citable as supplementary evidence (e.g. before a
        // staging cleanup), but every changed host still needs one check after its latest change.
        const validEvidence = (item: typeof evidence[number]) => !!item && item.operation.kind === 'command'
          && item.operation.readOnly === true && item.operation.status === 'succeeded'
          && changes.some((change) => change.operation.hostId === item.operation.hostId && change.index < item.index);
        const invalidIds = value.evidenceOperationIds.filter((_, index) => !validEvidence(evidence[index]));
        const missingHosts = [...latestByHost].filter(([hostId, changeIndex]) =>
          !evidence.some((item) => validEvidence(item) && item!.operation.hostId === hostId && item!.index > changeIndex))
          .map(([hostId]) => hostId);
        if (!latestByHost.size || !evidence.length || invalidIds.length || missingHosts.length) {
          const eligible = [...latestByHost].map(([hostId, changeIndex]) => {
            const ids = operations.slice(changeIndex + 1).filter((item) => item.hostId === hostId
              && item.kind === 'command' && item.readOnly === true && item.status === 'succeeded')
              .slice(-5).map((item) => item.id);
            return `${hostId}: ${ids.length ? ids.join(', ') : '无'}`;
          });
          return this.rejected('verification-evidence-invalid',
            `核验登记未成功。${invalidIds.length ? `不合格的证据 ID：${invalidIds.slice(0, 5).map((id) => indexed.has(id) ? id : '未知 ID').join(', ')}。` : ''}${missingHosts.length ? `缺少最后变更之后的合格只读检查：${missingHosts.join(', ')}。` : ''}`
            + `本轮各主机可引用的合格 ID：${eligible.join('；') || '无'}。仅引用这些 ID，勿重复已成功的检查；若无合格 ID，在全部变更/清理结束后执行一次单独的有界只读检查（例如对已知非秘密文件使用 sudo stat 或 sudo cat），再提交。复合或未被 SafetyGate 判为 effect-free 的命令不可充当证据；不要重复提交相同的无效 ID。`);
        }
        if (!value.summary.trim() || !value.access.length || !value.changes.length || !value.recovery.length
          || [...value.changes, ...value.recovery, ...value.access].some((text) => !text.trim())) {
          return this.rejected('verification-fields-missing', '报告缺少访问方式、变更或恢复说明（不适用时需明确写出）。');
        }
        if (reportHasCredentials(value)) return this.rejected('verification-secret', '报告可能含敏感信息，已拒绝保存；请移除后再提交。');
        if (operations.some(operationNeedsVerification)) {
          return this.rejected('verification-outcome-unresolved', '仍有未决远端操作结果，须先核验原结果，不能重放变更。');
        }
        this.reportIssue = undefined;
        this.report = structuredClone(value); this.notes = this.report; this.reportReason = undefined;
        this.emit({ type: 'work-report', taskId: this.taskId, report: value });
        return result('Verification report recorded; report the conclusion to the user');
      }
    };
    const log = createOperationLogTool(this.taskId, this.operations, this.readLog);
    const reconciliation = createReconciliationTool({ taskId: this.taskId, operations: this.operations,
      reconcile: this.reconcile, reconciled: this.reconciled });
    return [plan, report, log, reconciliation];
  }
}
