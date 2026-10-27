import { Type, type Static } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';
import type { AppEvent, OperationView, VerificationReport } from '@cloudhelm/contracts';
import { operationNeedsVerification, VerificationCheckSchema, UnverifiedChangeSchema, type VerificationReason } from '@cloudhelm/contracts';
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
  constructor(private readonly taskId: string, private readonly operations: () => OperationView[],
    private readonly emit: (event: AppEvent) => void,
    private readonly readLog: (operationId: string, cursor: number) => Promise<LogPage>,
    private readonly reconcile: (operation: OperationView) => boolean = () => false,
    private readonly reconciled: (operation: OperationView) => void = () => {},
    private readonly verificationOperations: () => OperationView[] = operations) {}

  resetReport(): void {
    this.report = undefined; this.reportReason = undefined;
    this.reportIssue = undefined;
    this.emit({ type: 'work-report', taskId: this.taskId });
  }
  hasReport(): boolean { return !!this.report; }
  completionReport(): { reportStatus?: 'verified' | 'unverified'; reportUnverifiedReason?: VerificationReason } {
    return this.report ? { reportStatus: this.reportReason ? 'unverified' : 'verified', reportUnverifiedReason: this.reportReason } : {};
  }
  lastReportIssue(): { code: string; guidance: string } | undefined { return this.reportIssue; }
  private rejected(code: string, guidance: string) {
    this.reportIssue = { code, guidance };
    return result(JSON.stringify(this.reportIssue), true);
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
    const reportParameters = Type.Object({ version: Type.Optional(Type.Literal(2)),
      checks: Type.Optional(Type.Array(VerificationCheckSchema, { maxItems: 32 })),
      unverifiedChanges: Type.Optional(Type.Array(UnverifiedChangeSchema, { maxItems: 64 })),
      summary: Type.String({ minLength: 1 }), access: Type.Array(Type.String()),
      evidenceOperationIds: Type.Array(Type.String(), { maxItems: 64 }),
      changes: Type.Array(Type.String(), { minItems: 1 }), recovery: Type.Array(Type.String(), { minItems: 1 }) });
    const report: BusinessTool<Static<typeof reportParameters>> = {
      name: 'submit_verification', label: 'Record change checks and uncertainty', replay: 'never', parameters: reportParameters,
      description: 'Use version=2 after changes: checks(changeOperationIds,target,expected,observed,evidenceOperationIds,status=passed/failed/inconclusive), unverifiedChanges(operationId,reason). Cover every real change; top evidenceOperationIds is the exact check-ID union. passed requires successful, SafetyGate-classified effect-free checks with exit=0; EACH changed host needs a check after its latest change, including cleanup. Reuse prior IDs; do not replay work to manufacture success. failed/inconclusive may be recorded honestly as unverified; no evidence means inconclusive, not failed/passed. This validates structure, not semantic relevance. Literal bounded sudo cat/ls/stat may qualify after review; glob/expansion, sudo head/find and opaque commands do not. Keep summary/access/changes/recovery in the language of the current user request (not applicable must be explicit); preserve literal paths/output, never credentials. Unversioned reports remain legacy format.',
      execute: async (_id, value) => {
        if (value.version !== undefined || value.checks !== undefined || value.unverifiedChanges !== undefined) {
          const validation = validateVerificationV2(this.taskId, value, this.verificationOperations(), this.operations());
          if (!validation.accepted) return this.rejected(validation.code, validation.guidance);
          this.report = validation.report; this.reportReason = validation.reason; this.reportIssue = undefined;
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
        this.report = structuredClone(value); this.reportReason = undefined;
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
