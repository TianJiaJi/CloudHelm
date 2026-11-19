import { randomUUID } from 'node:crypto';
import { executeReview } from './review-execution.js';
import {
  ApprovalInterruptedError, ReviewInterruptedError, decideSafety, validProcessControl, inspectScriptSafety, analyzeOperationImpact, nativeBackgroundEligible, nativeCommandEligible, nativePtySudoEligible, nativePtySuEligible, operationFingerprint, scriptFilePath, redactOutput,
  type ApprovalRequester, type CommandAnalysis, type CommandAnalyzer, type OperationAudit,
  type ExecutionOptions, type OperationExecutor, type OperationResult, type ProposedOperation, type RiskEvaluator,
  type SafetyDecision, type SafetySettings, type ScriptInspector, type TerminalLease
} from '@cloudhelm/core';

export interface GateOutcome {
  decision: SafetyDecision;
  /** Attested by this gate from the complete operation, never a caller assertion. */
  readOnly?: boolean;
  result?: OperationResult;
}

export interface SafetyGateDependencies {
  analyzer: CommandAnalyzer;
  scripts?: ScriptInspector;
  evaluator: RiskEvaluator;
  approvals: ApprovalRequester;
  executor: OperationExecutor;
  audit: OperationAudit;
  lease: TerminalLease;
  /** Task activity may continue only for an exact already-started background operation. */
  isOperationActive?(operation: ProposedOperation): boolean;
  /** Worker-owned review generation, revoked on stop/model/policy changes. */
  reviewSignal?(): AbortSignal;
  settings(hostId: string): SafetySettings;
}

function safeReviewBasis(reason: string): string {
  return redactOutput(reason).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 900);
}

export class SafetyGate {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SafetyGateDependencies) {}

  async execute(proposed: ProposedOperation, signal?: AbortSignal, manualReview = false,
    observer?: Pick<ExecutionOptions, 'onProcessStarted' | 'onFileInspection'>): Promise<GateOutcome> {
    if (this.inFlight.has(proposed.id)) throw new Error('Operation is already in progress');
    this.inFlight.add(proposed.id);
    try {
      const operation = structuredClone(proposed);
      const fingerprint = operationFingerprint(operation);
      const reviewSignal = this.deps.reviewSignal?.();
      await this.deps.audit.proposed(operation, fingerprint);
      if (!validProcessControl(operation)) {
        const decision = { verdict: 'error', ruleId: 'invalid-process-control', reason: 'Process control does not match its exact review binding; nothing sent' } as const;
        await this.deps.audit.decided(operation.id, decision, fingerprint);
        return { decision };
      }

      let analysis: CommandAnalysis | undefined;
      if (operation.kind === 'command') {
        try {
          analysis = await this.deps.analyzer.analyze(operation.command);
        } catch (error) {
          // Fail closed, but keep the cause: a silent "unavailable" hides broken deployments.
          const cause = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          const safety = { verdict: 'error', ruleId: 'analyzer-unavailable', reason: `Command analyzer is unavailable: ${cause}` } as const;
          await this.deps.audit.decided(operation.id, safety, fingerprint);
          return { decision: safety };
        }
      }
      if (operation.kind === 'command' && operation.executionChannel === 'native-exec'
        && (!analysis || !nativeCommandEligible(operation, analysis))) {
        const decision = { verdict: 'error', ruleId: 'invalid-execution-channel',
          reason: 'Backend execution channel no longer matches analyzed command; nothing sent' } as const;
        await this.deps.audit.decided(operation.id, decision, fingerprint);
        return { decision };
      }
      if (operation.kind === 'command' && operation.executionChannel === 'native-pty'
        && (!analysis || (!nativePtySudoEligible(operation, analysis) && !nativePtySuEligible(operation, analysis)))) {
        const decision = { verdict: 'error', ruleId: 'invalid-execution-channel',
          reason: 'Backend execution channel no longer matches analyzed command; nothing sent' } as const;
        await this.deps.audit.decided(operation.id, decision, fingerprint);
        return { decision };
      }
      if (operation.kind === 'command' && operation.executionChannel === 'native-background'
        && (!analysis || !nativeBackgroundEligible(operation, analysis))) {
        const decision = { verdict: 'error', ruleId: 'invalid-execution-channel',
          reason: 'Backend execution channel no longer matches analyzed command; nothing sent' } as const;
        await this.deps.audit.decided(operation.id, decision, fingerprint);
        return { decision };
      }
      const impact = analyzeOperationImpact(operation, analysis);
      const readOnly = impact.mutation === 'none';
      await this.deps.audit.classified?.(operation.id, readOnly, structuredClone(impact));

      let settings: SafetySettings;
      try { settings = this.deps.settings(operation.scope.hostId); }
      catch {
        const unavailable = { verdict: 'error', ruleId: 'policy-unavailable', reason: 'Safety policy is unavailable' } as const;
        await this.deps.audit.decided(operation.id, unavailable, fingerprint);
        return { decision: unavailable };
      }
      let safety = decideSafety(operation, settings, analysis);
      let inspectedScript: { path: string; sha256: string } | undefined;
      if (operation.kind === 'command' && analysis && safety.verdict !== 'deny' && safety.verdict !== 'error' && this.deps.scripts) {
        const path = scriptFilePath(analysis);
        if (path) {
          let inspected: Awaited<ReturnType<ScriptInspector['inspect']>> | undefined;
          try {
            inspected = await this.deps.scripts.inspect(operation, path);
          } catch { /* This file is opaque; the selected mode handles it below. */ }
          if (inspected) {
            inspectedScript = { path, sha256: inspected.sha256 };
            let scriptAnalysis: CommandAnalysis;
            try { scriptAnalysis = await this.deps.analyzer.analyze(inspected.source); }
            catch {
              const unavailable = { verdict: 'error', ruleId: 'analyzer-unavailable',
                reason: 'Inspected script could not be parsed; operation was not executed' } as const;
              await this.deps.audit.decided(operation.id, unavailable, fingerprint);
              return { decision: unavailable };
            }
            const result = inspectScriptSafety(operation, inspected.source, scriptAnalysis, settings);
            safety = result;
          } else if (settings.mode !== 'permissive') {
            // An unreadable script never downgrades a decision that already carries
            // higher risk (for example a high-impact wrapper command).
            const fallback = settings.mode === 'ai-review'
              ? { verdict: 'evaluate' as const, ruleId: 'script-uninspectable',
                reason: 'Script could not be read safely before execution', impact: 'unknown' as const }
              : { verdict: 'ask' as const, ruleId: 'script-uninspectable',
                reason: 'Script could not be read safely before execution', impact: 'unknown' as const };
            safety = safety.impact === 'high' || safety.verdict === 'evaluate' ? safety : fallback;
          }
        }
      }
      /** Binding after dispatch: content, host, terminal, policy version and
       * identity revisions. The worker review lifetime is deliberately absent:
       * revoking it ends not-yet-started review work, but a routine revoke on
       * task completion must not deauthorize an already-started background
       * process, which keeps its write lock until its exit is observed. */
      const dispatchCurrent = () => {
        try {
          const current = this.deps.settings(operation.scope.hostId);
          return this.deps.lease.isAgentOwner(operation.scope.terminalId)
            && this.deps.isOperationActive?.(operation) !== false
            && this.deps.lease.currentGeneration(operation.scope.terminalId) === operation.scope.terminalGeneration
            && current.revision === operation.scope.policyRevision
            && (operation.scope.conversationRevision === undefined || current.conversationRevision === operation.scope.conversationRevision)
            && (operation.scope.reviewerRevision === undefined || current.reviewerRevision === operation.scope.reviewerRevision)
            && operationFingerprint(operation) === fingerprint && !signal?.aborted;
        } catch { return false; }
      };
      const stillCurrent = () => dispatchCurrent() && !reviewSignal?.aborted;
      if (manualReview && safety.verdict !== 'deny' && safety.verdict !== 'error') safety = {
        verdict: 'ask', ruleId: 'ai-denial-manual-review', reason: `User requested a one-time review of this exact denied operation；静态依据：${safeReviewBasis(safety.reason)}`
      };
      if (safety.verdict === 'evaluate') {
        const basis = safeReviewBasis(`[${safety.ruleId}] ${safety.reason}`);
        const review = await executeReview(this.deps.evaluator, operation, analysis, {
          classification: safety, inspectedScriptSha256: inspectedScript?.sha256, impactAnalysis: structuredClone(impact)
        }, stillCurrent, signal, reviewSignal);
        if (review.kind === 'canceled' || review.kind === 'stale' || !stillCurrent()) {
          const canceled = review.kind === 'canceled' || signal?.aborted
            || reviewSignal?.reason instanceof ReviewInterruptedError && reviewSignal.reason.outcome === 'canceled';
          const interrupted: SafetyDecision = { verdict: 'error',
            ruleId: canceled ? 'review-canceled' : 'authorization-expired',
            reason: `${canceled ? '审核已取消' : '审核绑定已失效'}，操作未执行；静态依据：${basis}` };
          await this.deps.audit.decided(operation.id, interrupted, fingerprint);
          return { decision: interrupted };
        }
        const timedOut = review.kind === 'timeout';
        const assessment = review.kind === 'assessment' ? review.assessment
          : { verdict: 'error' as const, reason: '审核模型等待超时' };
        const result = typeof assessment === 'string' ? { verdict: assessment } : assessment;
        const detail = result.reason ? `：${safeReviewBasis(result.reason).slice(0, 400)}` : result.verdict === 'deny' ? '（审核模型未提供具体理由）' : '';
        safety = result.verdict === 'allow'
          ? { verdict: 'allow', ruleId: 'ai-review-allow', reason: `独立审核已放行${detail}；静态依据：${basis}` }
          : result.verdict === 'deny'
            ? { verdict: 'deny', ruleId: 'ai-review-deny', reason: `独立审核拒绝该操作${detail}；静态依据：${basis}` }
            : { verdict: 'ask', ruleId: result.verdict === 'error' ? timedOut ? 'ai-review-timeout' : 'ai-review-unavailable' : 'ai-review-uncertain',
              reason: `独立审核需要人工判断${detail}；静态依据：${basis}` };
      }

      if (safety.verdict === 'ask') {
        const basis = safeReviewBasis(`[${safety.ruleId}] ${safety.reason}`);
        if (signal?.aborted || reviewSignal?.aborted && reviewSignal.reason instanceof ReviewInterruptedError && reviewSignal.reason.outcome === 'canceled') {
          const canceled = { verdict: 'error', ruleId: 'review-canceled', reason: `Operation was canceled before review；审核依据：${basis}` } as const;
          await this.deps.audit.decided(operation.id, canceled, fingerprint);
          return { decision: canceled };
        }
        const request = { id: randomUUID(), operation, fingerprint, ruleId: safety.ruleId, reason: safety.reason,
          impact: safety.impact,
          targets: operation.kind === 'command' ? [...new Set([
            ...(analysis?.redirectTargets ?? []),
            ...(analysis?.calls.flatMap((call) => call.args.filter((arg) => /^(?:\/|\.\.?\/)/u.test(arg))) ?? [])
          ])].slice(0, 8) : [operation.kind === 'upload' ? operation.remotePath : operation.path],
          scriptSha256: inspectedScript?.sha256, expiresAt: Date.now() + 10 * 60_000 };
        const approvalSignal = reviewSignal ? AbortSignal.any([reviewSignal, ...(signal ? [signal] : [])]) : signal;
        const approval = stillCurrent() ? await this.awaitApproval(request, approvalSignal) : 'stale';
        const staleReview = !signal?.aborted && reviewSignal?.aborted
          && !(reviewSignal.reason instanceof ReviewInterruptedError && reviewSignal.reason.outcome === 'canceled');
        safety = staleReview
          ? { verdict: 'error', ruleId: 'authorization-expired', reason: 'Review generation changed; operation was not executed' }
          : ['expired', 'canceled', 'unavailable'].includes(approval)
          ? { verdict: 'error', ruleId: approval === 'expired' ? 'approval-expired' : approval === 'canceled' ? 'review-canceled' : 'approval-unavailable',
            reason: 'Approval did not complete; operation was not executed' }
          : !stillCurrent() || approval === 'stale'
            ? { verdict: 'error', ruleId: 'authorization-expired', reason: 'Terminal, policy, or operation changed during review' }
            : approval === 'approved' ? { verdict: 'allow', ruleId: 'human-approved', reason: 'User approved this exact operation' }
              : { verdict: 'deny', ruleId: 'human-denied', reason: 'User declined this operation; it was not executed' };
        safety = { ...safety, reason: `${safety.reason}；审核依据：${basis}` };
      }

      if (safety.verdict !== 'allow') {
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }

      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: `Terminal, policy, or operation changed before execution；先前依据：${safeReviewBasis(`[${safety.ruleId}] ${safety.reason}`)}` };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }
      if (inspectedScript && operation.kind === 'command') {
        let unchanged = false;
        try { unchanged = await this.deps.scripts!.verify(operation, inspectedScript.path, inspectedScript.sha256); } catch { /* deny below */ }
        if (!unchanged || !stillCurrent()) {
          safety = { verdict: 'error', ruleId: 'script-changed', reason: `Inspected script changed or could not be rechecked before execution；先前依据：${safeReviewBasis(`[${safety.ruleId}] ${safety.reason}`)}` };
          await this.deps.audit.decided(operation.id, safety, fingerprint);
          return { decision: safety };
        }
      }

      await this.deps.audit.decided(operation.id, safety, fingerprint);
      if (!stillCurrent()) {
        safety = { verdict: 'error', ruleId: 'authorization-expired', reason: `Authorization changed while recording the decision；先前依据：${safeReviewBasis(`[${safety.ruleId}] ${safety.reason}`)}` };
        await this.deps.audit.decided(operation.id, safety, fingerprint);
        return { decision: safety };
      }
      let result: OperationResult;
      try { result = await this.deps.executor.execute(operation, fingerprint, signal, { readOnly, impactAnalysis: structuredClone(impact), isAuthorized: dispatchCurrent, onProcessStarted: observer?.onProcessStarted, onFileInspection: observer?.onFileInspection }); }
      catch (error) {
        result = { operationId: operation.id, status: 'unknown', stdoutTail: error instanceof Error ? error.message : String(error) };
      }
      // Query semantics establish absence of business mutation, not process exit.
      // Keep unknown/handed-over outcomes and all authentication/control metadata.
      if (readOnly && ['succeeded', 'failed'].includes(result.status)
        && Number.isInteger(result.exitCode) && result.exitCode! >= 0) result = { ...result, effects: 'none' };
      await this.deps.audit.completed(result);
      return { decision: safety, readOnly, result };
    } finally {
      this.inFlight.delete(proposed.id);
    }
  }

  private async awaitApproval(request: Parameters<ApprovalRequester['requestApproval']>[0], signal?: AbortSignal): Promise<'approved' | 'denied' | 'expired' | 'canceled' | 'stale' | 'unavailable'> {
    let interrupt!: (outcome: 'expired' | 'canceled') => void;
    let closed = false, cleanupFailed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { this.deps.approvals.cancelApproval?.(request.id); }
      catch { cleanupFailed = true; }
    };
    const stopped = new Promise<'expired' | 'canceled'>((resolve) => { interrupt = resolve; });
    const stop = () => { close(); interrupt('canceled'); };
    const timer = setTimeout(() => { close(); interrupt('expired'); }, Math.max(0, request.expiresAt - Date.now()));
    signal?.addEventListener('abort', stop, { once: true });
    let result: 'approved' | 'denied' | 'expired' | 'canceled' | 'stale' | 'unavailable' = 'unavailable';
    try {
      if (signal?.aborted) result = 'canceled';
      else {
        const reply = this.deps.approvals.requestApproval(structuredClone(request))
          .then((approved) => typeof approved !== 'boolean' ? 'unavailable' as const : approved ? 'approved' as const : 'denied' as const);
        result = await Promise.race([reply, stopped]);
      }
    } catch (error) {
      result = error instanceof ApprovalInterruptedError && ['canceled', 'expired', 'stale'].includes(error.outcome)
        ? error.outcome : 'unavailable';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      close();
    }
    if (cleanupFailed) return 'unavailable';
    return signal?.aborted ? 'canceled' : Date.now() >= request.expiresAt ? 'expired' : result;
  }
}
