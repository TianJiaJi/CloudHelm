import { Type, type Static } from 'typebox';
const signal = Type.Union([Type.Literal('detected'), Type.Literal('not-detected'), Type.Literal('unknown')]);
/** Observation metadata only; consumers must never use this as an approval. */
export const OperationImpactSchema = Type.Object({
  version: Type.Literal(1), mutation: Type.Union([Type.Literal('none'), Type.Literal('possible')]),
  sensitiveRead: signal, externalTransfer: signal, codeExecution: signal,
  evidence: Type.Union([Type.Literal('query-proof'), Type.Literal('structured-file'), Type.Literal('known-mutation'), Type.Literal('unproven')]),
  uncertaintyCodes: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }), { maxItems: 4 })
}, { additionalProperties: false });
export type OperationImpactView = Static<typeof OperationImpactSchema>;
