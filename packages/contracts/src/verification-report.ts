import { Type, type Static } from 'typebox';
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const VerificationCheckSchema = Type.Object({
  changeOperationIds: Type.Array(Id, { minItems: 1, maxItems: 64 }), target: Text(512), expected: Text(1024), observed: Text(2048),
  evidenceOperationIds: Type.Array(Id, { maxItems: 16 }),
  status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('inconclusive')])
}, { additionalProperties: false });
export type VerificationCheck = Static<typeof VerificationCheckSchema>;
export const UnverifiedChangeSchema = Type.Object({ operationId: Id, reason: Text(1024) }, { additionalProperties: false });
export const VerificationReportV2Schema = Type.Object({
  version: Type.Literal(2), summary: Text(4096),
  access: Type.Array(Text(2048), { minItems: 1, maxItems: 16 }),
  evidenceOperationIds: Type.Array(Id, { maxItems: 64 }),
  changes: Type.Array(Text(2048), { minItems: 1, maxItems: 32 }),
  recovery: Type.Array(Text(2048), { minItems: 1, maxItems: 32 }),
  checks: Type.Array(VerificationCheckSchema, { maxItems: 32 }),
  unverifiedChanges: Type.Array(UnverifiedChangeSchema, { maxItems: 64 })
}, { additionalProperties: false });
export type VerificationReportV2 = Static<typeof VerificationReportV2Schema>;
/** Optional new fields keep historical reports readable without upgrading them. */
export interface VerificationReport {
  version?: 2; checks?: VerificationCheck[]; unverifiedChanges?: Array<{ operationId: string; reason: string }>;
  summary: string; access: string[]; evidenceOperationIds: string[]; changes: string[]; recovery: string[];
}
export type VerificationReason = 'report-missing' | 'checks-failed' | 'checks-inconclusive' | 'changes-unverified';
export interface VerificationState { status: 'verified' | 'unverified'; operationIds: string[]; reasonCode?: VerificationReason }
