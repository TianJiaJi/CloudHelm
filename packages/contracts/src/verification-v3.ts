import { Type, type Static } from 'typebox';
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const Status = Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('inconclusive')]);

/** Expectations are model proposals, never execution permission or proof of user intent. */
export const OutputExpectationSchema = Type.Object({ expectedOutput: Type.String({ maxLength: 16384 }),
  expectedExitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })) }, { additionalProperties: false });
export type OutputExpectation = Static<typeof OutputExpectationSchema>;

export const VerificationSubmissionV3Schema = Type.Object({
  version: Type.Literal(3),
  summary: Type.Optional(Text(4096)),
  recovery: Type.Optional(Type.Array(Text(2048), { maxItems: 16 })),
  checks: Type.Optional(Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('run-output'), operationId: Id, expectedOutput: Type.String({ maxLength: 16384 }),
      expectedExitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('model-assessment'), target: Text(512), expected: Text(1024), observed: Text(2048),
      evidenceOperationId: Id, status: Status }, { additionalProperties: false })
  ]), { maxItems: 32 }))
}, { additionalProperties: false });
export type VerificationSubmissionV3 = Static<typeof VerificationSubmissionV3Schema>;
export interface VerificationRound {
  version: 1;
  id: string;
  operationIds: string[];
  closed: boolean;
}
export interface GoalCheck {
  kind: 'run-output' | 'run-completion' | 'file-content' | 'model-assessment';
  expectationSource?: 'before-execution' | 'report';
  authority: 'deterministic' | 'model';
  target: string;
  operationIds: string[];
  status: 'passed' | 'failed' | 'inconclusive';
  expected: string;
  observed: string;
}
export interface VerificationFacts {
  roundId: string;
  revision: number;
  registration: 'automatic' | 'submitted';
  execution: 'none' | 'succeeded' | 'succeeded-after-retry' | 'failed' | 'unknown';
  recoveredAttemptIds?: string[];
  goals: 'not-checked' | 'execution-observed' | 'passed' | 'failed' | 'inconclusive' | 'model-assessed';
  impact: 'effect-free' | 'not-assessed' | 'risk-accepted' | 'unresolved';
  operations: Array<{ operationId: string; hostId: string; kind?: 'command' | 'write-file' | 'upload' | 'delete-path'; status: string; exitCode?: number; readOnly?: boolean }>;
  /** Still-uncertain explicit risk acceptances, including earlier rounds. Real observed success may supersede uncertainty. */
  riskOperationIds: string[];
  unresolvedOperationIds: string[];
  /** Successful non-read-only operations without a deterministic goal observation. Not proof of mutation. */
  uncheckedOperationIds: string[];
}
/** Captured from the full operation before execution; never inferred from preview text. */
export type VerificationSource = { kind: 'file-write'; path: string; sha256: string; textSha256?: string }
  | { kind: 'file-read'; path: string }
  | { kind: 'program-run'; path: string; identity: string };
