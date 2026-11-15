import type { ApprovalRequest, CommandAnalysis, InputRequest, OperationResult, ProposedOperation, SafetyDecision } from './model.js';

import type { OperationImpact } from './operation-impact.js';

export interface CommandAnalyzer {
  analyze(command: string): Promise<CommandAnalysis>;
}

export interface ScriptInspector {
  inspect(operation: ProposedOperation & { kind: 'command' }, scriptPath: string): Promise<{ source: string; sha256: string }>;
  verify(operation: ProposedOperation & { kind: 'command' }, scriptPath: string, sha256: string): Promise<boolean>;
}

export interface RiskEvaluator {
  evaluate(operation: ProposedOperation, analysis: CommandAnalysis | undefined,
    context?: { classification: SafetyDecision; inspectedScriptSha256?: string; impactAnalysis?: OperationImpact },
    signal?: AbortSignal): Promise<RiskAssessment | RiskAssessment['verdict']>;
}

export interface RiskAssessment {
  verdict: 'allow' | 'review' | 'deny' | 'error';
  reason?: string;
  reviewer?: string;
}

export interface ApprovalRequester {
  /** Boolean means an explicit human decision only. Timeout/cancel/stale
   * adapters reject with ApprovalInterruptedError instead of resolving false. */
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  cancelApproval?(requestId: string): void;
}

export interface ExecutionOptions {
  /** Private backend callback: never serialize file contents into ordinary logs. */
  onFileInspection?: (snapshot: import('./file-transaction.js').FileInspection) => void;
  /** Minted only by SafetyGate's deterministic read-only classification. */
  readOnly?: boolean;
  /** Backend facts only, not a grant to bypass isAuthorized or host locks. */
  impactAnalysis?: OperationImpact;
  /** Synchronous final authorization check; adapters call it before each new side effect. */
  isAuthorized?: () => boolean;
  /** Trusted supervised-process observation. Not proof of target authentication or readiness. */
  onProcessStarted?: (event: { pid: number }) => void;
}

export interface OperationExecutor {
  /** Driver availability only, not a grant or proof that a host supports metadata preservation. */
  readonly supportsFileTransactions?: boolean;
  /** Control may target a live operation, never bypass a different/unknown host write lock. */
  canControlOperation?(hostId: string, operationId: string): boolean;
  reconcile?(hostId: string, operationId: string): boolean;
  execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult>;
}

export interface OperationAudit {
  proposed(operation: ProposedOperation, fingerprint: string): Promise<void>;
  classified?(operationId: string, readOnly: boolean, impact?: OperationImpact): Promise<void>;
  decided(operationId: string, decision: SafetyDecision, fingerprint: string): Promise<void>;
  completed(result: OperationResult): Promise<void>;
}

export interface InputPresenter {
  requestInput(request: InputRequest): Promise<string | null>;
}

export interface TerminalLease {
  currentGeneration(terminalId: string): number;
  isAgentOwner(terminalId: string): boolean;
}

export interface RawTerminal {
  /** Trusted process-transport event, never inferred from command output or model settlement. */
  onProcessStarted?(listener: (event: { pid: number }) => void): void;
  /** Dedicated control protocol for the currently observed process, never ordinary stdin. */
  interrupt?(expectedPid: number): Promise<'sent' | 'already-exited'>;
  /** Manual-shell directory projection; never grants an Agent lease. */
  onCwd?(listener: (directory: string) => void): void;
  onCommand?(listener: (event: { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }) => void): void;
  /** Separate process/control channel; command text is never rewritten as terminal input. */
  execute?(command: string, cwd: string, isAuthorized: () => boolean, options?: { sudoAuthorization?: boolean }): Promise<void>;
  onExecutionFailure?(listener: (failure: Pick<OperationResult, 'failureKind' | 'effects' | 'privilege'>) => void): void;
  onExit?(listener: (exitCode: number | undefined) => void): void;
  /** Prompt/command echo for the terminal only, separate from captured command output. */
  onDisplay?(listener: (data: string) => void): void;
  onAuthentication?(listener: (challenge: { id: string; prompt?: string }) => void): void;
  answerAuthentication?(id: string, answer: string | null): boolean;
  takeOver?(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
}
