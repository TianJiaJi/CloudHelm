export type ReviewMode = 'ask' | 'ai-review' | 'permissive' | 'preauthorized';

/** One bounded command shape a user pre-authorized for a host. */
export interface PreauthorizationCommandRule {
  program: string;
  argumentPrefix?: string[];
}

/** User-declared, versioned pre-authorization scope. Hard gates, disclosure,
 * identity and write-lock checks never depend on this scope; matching only
 * lifts the uncertainty tier for exactly the declared shapes. */
export interface PreauthorizationScope {
  revision: number;
  commands: PreauthorizationCommandRule[];
  paths: string[];
  kinds: Array<'upload' | 'write-file' | 'delete-path'>;
}

export interface OperationIntent {
  originalGoal: string;
  currentInput: string;
  clarifications: Array<{ id: string; text: string }>;
  origin: 'explicit' | 'legacy';
}

export interface OperationScope {
  taskId: string;
  hostId: string;
  cwd: string;
  runAs: string;
  loginAs?: string;
  sessionId?: string;
  connectionGeneration?: number;
  terminalId: string;
  terminalGeneration: number;
  policyRevision: number;
  conversationRevision?: number;
  reviewerRevision?: number;
  allowedWorkingRoots: string[];
  /** Legacy combined rule; new scopes set the directional lists below. */
  protectedPaths: string[];
  protectedReadPaths?: string[];
  protectedWritePaths?: string[];
  goal: string;
  /** Backend-maintained intent, never reconstructed from display text or remote output. */
  intent?: OperationIntent;
}

/** Orchestration-level delegation identity, shared by every operation variant.
 * `delegationId` is backend-generated per delegated work unit; `toolCallId` is the
 * model-facing tool-call trace (when the model initiated one). Neither is a safety grant. */
export interface OperationDelegation {
  delegationId?: string;
  toolCallId?: string;
}

/** Same-proposer explicit confirmation of one previously proposed operation.
 * Carries no authority of its own: the gate re-verifies the referenced binding
 * (content fingerprint, identity, policy and terminal generations, expiry)
 * before a confirmation can contribute to any decision. */
export interface OperationAdjudication {
  /** Reference to the receipt the gate returned with the prior outcome. */
  adjudicationId: string;
  /** Explicit second confirmation by the same proposer. */
  confirmed: boolean;
  /** Cited grounds for the confirmation; redacted and bounded before audit. */
  basis: string[];
}

/** Optional model-supplied confirmations for a re-proposed operation. */
export interface OperationAdjudications {
  adjudications?: OperationAdjudication[];
}

export type ProposedOperation = OperationDelegation & OperationAdjudications &
  (
    | { id: string; kind: 'inspect-file'; path: string; privilege?: 'root'; recoveryDirectoryId?: string; scope: OperationScope }
    | { id: string; kind: 'command'; command: string; serviceUnit?: string;
      /** Background lifetime is explicitly bound into review, never inferred from shell syntax. */
      executionMode?: 'background';
      /** Backend-selected, reviewed transport; absent on legacy records. Not a safety grant. */
      executionChannel?: 'native-exec' | 'native-pty' | 'native-background';
      /** Backend-created control descriptor. The command is review text, never executed as shell. */
      processControl?: { kind: 'interrupt'; jobId: string; targetOperationId: string; pid: number;
        processSequence: number; connectionId: string };
      /** Operation-level root request, normalized before review; never an approval. */
      privilege?: 'root';
      /** Backend-created preflights. Model tools cannot set them. `identity` is the
       * identity-discovery probe; `recovery` collects read-only service evidence after
       * an unknown result, bound to that operation by `recoveryTarget`. */
      probe?: 'identity' | 'recovery';
      recoveryTarget?: string;
      outputExpectation?: { expectedOutput: string; expectedExitCode?: number }; scope: OperationScope }
  | { id: string; kind: 'write-file'; path: string; content: string; scope: OperationScope;
      privilege?: 'root'; fileEdit?: import('./file-transaction.js').FileEditCommit;
      /** Compare-and-swap: the exact content hash the review was based on. Required when
       * replacing an existing file, so a truncated excerpt cannot become a full overwrite. */
      expectedSha256?: string;
      /** Only valid when the target must not exist yet. */
      createOnly?: boolean }
  | { id: string; kind: 'upload'; localPath: string; remotePath: string; localRoot: string; contentSha256: string; size: number; scope: OperationScope }
  | { id: string; kind: 'delete-path'; path: string; scope: OperationScope }
  /** Container directory of private recovery material; read-only bounded listing. */
  | { id: string; kind: 'list-recovery'; path: string; scope: OperationScope; privilege?: 'root' }
  /** Explicit reviewed removal of named private recovery material; never automatic. */
    | { id: string; kind: 'cleanup-recovery'; path: string; names: string[]; scope: OperationScope; privilege?: 'root' }
  );

/** Lexical cwd relative to the operation entry directory, not remote realpath evidence. */
export type CommandDirectory = { state: 'known'; changes: string[] } | { state: 'unknown' };

export interface CommandContext {
  cwd: CommandDirectory;
  /** Requested identity is not evidence of successful authentication. */
  identity: { state: 'inherited' } | { state: 'requested'; user?: string; group?: string } | { state: 'unknown' };
  namespace: 'inherited' | 'unknown';
  unknownReasons: string[];
}

export interface CommandPathEffect {
  kind: 'read' | 'write';
  path: string;
  directory: CommandDirectory;
  /** Directory traversal/extraction may affect descendants, not only the operand. */
  recursive?: boolean;
}

export interface GitCommandSemantics {
  subcommand?: string;
  args: string[];
  directory: CommandDirectory;
  paths: CommandPathEffect[];
}

export interface TarCommandSemantics {
  mode?: 'create' | 'list' | 'extract';
  paths: CommandPathEffect[];
}

export interface CommandSemantics {
  /** Coverage of supported argv semantics, not proof of all runtime effects or remote path identity. */
  coverage: 'complete' | 'partial';
  unknownReasons: string[];
  git?: GitCommandSemantics;
  tar?: TarCommandSemantics;
}

export interface CommandCall {
  name: string;
  args: string[];
  dynamic: boolean;
  redirects: boolean;
  context?: CommandContext;
  semantics?: CommandSemantics;
  /** Range in raw source, or in the separately labelled embedded shell source. */
  source?: { start: number; end: number; depth: number };
}

export interface CommandAnalysis {
  calls: CommandCall[];
  /** Literal foreground commands in shell evaluation order; absent for opaque syntax. */
  steps?: Array<{ call: CommandCall; condition: 'always' | 'success' | 'failure' }>;
  /** Parser evidence for exactly one foreground literal pipeline, not a flattened list.
   * Every stage must match a depth-zero call's original source span. */
  literalPipeline?: { stages: Array<{ start: number; end: number }> };
  redirectTargets: string[];
  /** Per-redirection shell context; wrapper cwd does not affect shell redirection. */
  redirectEffects?: Array<{ target: string; context: CommandContext }>;
  /** Input file redirections are reads, never write targets. No inline heredoc bodies. */
  readRedirectEffects?: Array<{ target: string; context: CommandContext }>;
  /** New analyzers attach scoped contexts; absent for legacy synthetic analysis. */
  scopedContexts?: boolean;
  hasExpansion: boolean;
  hasPipeline: boolean;
  hasCompound: boolean;
  hasRedirection: boolean;
  hasError: boolean;
  raw: string;
}

export interface SafetyDecision {
  verdict: 'allow' | 'ask' | 'evaluate' | 'deny' | 'error';
  ruleId: string;
  reason: string;
  impact?: 'ordinary' | 'high' | 'unknown';
  /** Receipt metadata for an 'adjudication-required' decision: a reference the
   * proposer returns with its explicit confirmation, never a replayable grant. */
  adjudication?: { id: string; expiresAt: number; fingerprint: string };
  /** Present when the allowance comes from a user-declared pre-authorization
   * scope rather than model review; the match names the exact scope entry. */
  decisionSource?: 'user-preauthorization';
  preauthorizationMatch?: string;
  autoAdjudicated?: true;
}

export interface SafetySettings {
  mode: ReviewMode;
  revision: number;
  conversationRevision?: number;
  reviewerRevision?: number;
  preauthorization?: PreauthorizationScope;
}

export interface OperationResult {
  fileRecovery?: import('./file-transaction.js').FileRecovery;
  /** Delivery outcome only; never asserts that the target process exited. */
  processControl?: { kind: 'interrupt'; jobId: string; targetOperationId: string; delivery: 'sent' | 'already-exited' | 'unknown' };
  operationId: string;
  status: 'succeeded' | 'failed' | 'unknown' | 'handed-over';
  /** Dispatch-boundary handoff fact. Producers that cannot attest leave it unset; the reduction reports unknown. */
  handoff?: 'not-sent' | 'handed-off' | 'unknown';
  /** Whether the reviewed business action provably began (or provably never began); never inferred from output text. */
  businessStart?: 'not-started' | 'started' | 'unknown';
  /** Liveness of the dispatched process at the last trusted observation; never inferred from silence. */
  liveness?: 'running' | 'exited' | 'unknown';
  exitCode?: number;
  authentication?: 'succeeded' | 'required' | 'failed';
  authenticationAttempts?: number;
  privilege?: import('./privilege.js').PrivilegeFeedback;
  failureKind?: 'authentication-required' | 'permission-denied' | 'authentication-failed' | 'unsupported' | 'user-action-required' | 'unresolved-prior-operation' | 'not-dispatched' | 'unknown';
  effects?: 'none' | 'possible' | 'observed-change';
  stdoutTail: string;
  /** Redacted observation counts; not evidence of process exit or durable log retention. */
  outputCapture?: { totalChars: number; tailChars: number; truncated: boolean };
  logRef?: string;
  cwd?: string;
  /** Authentication or an unsupported interaction requires an explicit user decision. */
  requiresUserAction?: boolean;
  /** Runtime-only evidence that a handed-over PTY command actually left the foreground. */
  remoteCompletion?: Promise<'exited' | 'unknown'>;
}

/** Partial facts a terminal reports through the failure channel before settling;
 * every field is optional and absent facts surface as unknown in the reduction. */
export type ExecutionFailureFact = Pick<OperationResult, 'failureKind' | 'effects' | 'privilege' | 'requiresUserAction' | 'handoff' | 'businessStart' | 'liveness'>;

export interface ApprovalRequest {
  id: string;
  operation: ProposedOperation;
  fingerprint: string;
  ruleId: string;
  reason: string;
  impact?: SafetyDecision['impact'];
  targets?: string[];
  scriptSha256?: string;
  expiresAt: number;
  /** Server-enforced absolute deadline; soft expiry only reminds until here. */
  hardExpiresAt?: number;
}

export interface InputRequest {
  id: string;
  operationId: string;
  taskId: string;
  hostId: string;
  terminalId: string;
  terminalGeneration: number;
  connectionGeneration: number;
  kind: 'confirmation' | 'text' | 'secret' | 'otp';
  recipient: string;
  reason: string;
  prompt: string;
  choices?: string[];
  expiresAt: number;
}
