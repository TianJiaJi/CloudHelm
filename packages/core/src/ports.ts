import type { ApprovalRequest, CommandAnalysis, InputRequest, OperationResult, ProposedOperation, SafetyDecision } from './model.js';

export interface CommandAnalyzer {
  analyze(command: string): Promise<CommandAnalysis>;
}

export interface ScriptInspector {
  inspect(operation: ProposedOperation & { kind: 'command' }, scriptPath: string): Promise<{ source: string; sha256: string }>;
  verify(operation: ProposedOperation & { kind: 'command' }, scriptPath: string, sha256: string): Promise<boolean>;
}

export interface RiskEvaluator {
  evaluate(operation: ProposedOperation, analysis: CommandAnalysis | undefined): Promise<RiskAssessment | RiskAssessment['verdict']>;
}

export interface RiskAssessment {
  verdict: 'allow' | 'review' | 'deny' | 'error';
  reason?: string;
  reviewer?: string;
}

export interface ApprovalRequester {
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  cancelApproval?(requestId: string): void;
}

export interface ExecutionOptions {
  /** Minted only by SafetyGate's deterministic read-only classification. */
  readOnly?: boolean;
  /** Synchronous final authorization check; adapters call it before each new side effect. */
  isAuthorized?: () => boolean;
}

export interface OperationExecutor {
  reconcile?(hostId: string, operationId: string): boolean;
  execute(operation: ProposedOperation, fingerprint: string, signal?: AbortSignal, options?: ExecutionOptions): Promise<OperationResult>;
}

export interface OperationAudit {
  proposed(operation: ProposedOperation, fingerprint: string): Promise<void>;
  classified?(operationId: string, readOnly: boolean): Promise<void>;
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
  onCommand?(listener: (event: { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }) => void): void;
  /** Separate process/control channel; command text is never rewritten as terminal input. */
  execute?(command: string, cwd: string, isAuthorized: () => boolean): Promise<void>;
  onExecutionFailure?(listener: (failure: Pick<OperationResult, 'failureKind' | 'effects'>) => void): void;
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
