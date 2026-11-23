import { Type } from 'typebox';
import { FILE_EDIT_MAX_BYTES } from '@cloudhelm/core';
import { AdjudicationSchema } from '@cloudhelm/contracts';

export const remoteFileEditParameters = Type.Object({
  hostId: Type.String({ minLength: 1 }),
  privilege: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('root')])),
  path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }),
  expectedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  oldText: Type.String({ minLength: 0, maxLength: FILE_EDIT_MAX_BYTES }),
  newText: Type.String({ maxLength: FILE_EDIT_MAX_BYTES }),
  adjudications: Type.Optional(Type.Array(AdjudicationSchema, { maxItems: 8 }))
}, { additionalProperties: false });
