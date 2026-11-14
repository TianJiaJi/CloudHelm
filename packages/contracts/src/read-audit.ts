import { Type, type Static } from 'typebox';

const Code = Type.Union([Type.Literal('requested'), Type.Literal('allowed'), Type.Literal('protected-resource'),
  Type.Literal('credential-resource'), Type.Literal('host-out-of-scope'), Type.Literal('invalid-path'),
  Type.Literal('read-failed'), Type.Literal('cancelled'), Type.Literal('policy-changed'), Type.Literal('task-inactive'), Type.Literal('completed')]);
/** Metadata only: never file content, a hash of secret content, or raw server errors. */
export const RemoteReadAuditSchema = Type.Object({
  version: Type.Literal(1),
  path: Type.String({ maxLength: 4096 }),
  policyRevision: Type.Integer({ minimum: 0 }),
  events: Type.Array(Type.Object({
    phase: Type.Union([Type.Literal('requested'), Type.Literal('authorized'), Type.Literal('denied'), Type.Literal('completed'), Type.Literal('failed')]),
    code: Code,
    at: Type.Integer({ minimum: 0 }),
    redacted: Type.Optional(Type.Boolean()),
    truncated: Type.Optional(Type.Boolean()),
    bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 })
}, { additionalProperties: false });
export type RemoteReadAudit = Static<typeof RemoteReadAuditSchema>;
export type RemoteReadAuditEvent = RemoteReadAudit['events'][number];
