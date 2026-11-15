import { Type } from 'typebox';
import { FILE_EDIT_MAX_BYTES } from '@cloudhelm/core';

export const remoteFileEditParameters = Type.Object({
  hostId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }),
  expectedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  oldText: Type.String({ minLength: 1, maxLength: FILE_EDIT_MAX_BYTES }),
  newText: Type.String({ maxLength: FILE_EDIT_MAX_BYTES })
}, { additionalProperties: false });
