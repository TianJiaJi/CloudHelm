import path from 'node:path';

/** Reads for the model's edit loop are a separate capability from command review,
 * so the same boundaries must be enforced here: resolved literals only, never a
 * user-protected tree, never a credential file. Reading also never elevates. */
const CREDENTIAL = /(?:^|\/)(?:\.ssh\/(?:id_[^/]+|authorized_keys)|\.env(?:\.[^/]+)?|\.Xauthority(?:-[^/]*)?)$/u;
const SYSTEM_CREDENTIAL = /^\/(?:etc\/(?:shadow|gshadow)|root\/\.ssh\/)/u;

export class RemoteReadPolicyError extends Error {
  constructor(readonly code: 'invalid-path' | 'protected-resource' | 'credential-resource', message: string) { super(message); }
}

export function resolveRemoteReadTarget(filePath: string, cwd: string | undefined): string {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(filePath))
    throw new RemoteReadPolicyError('invalid-path', 'Invalid remote read path');
  const target = filePath.startsWith('/') ? path.posix.normalize(filePath) : path.posix.resolve(cwd ?? '/', filePath);
  if (!target.startsWith('/') || target.split('/').includes('..')) throw new RemoteReadPolicyError('invalid-path', 'Invalid remote read path');
  return target;
}

export function assertRemoteReadAllowed(target: string, protectedReadPaths: readonly string[]): void {
  target = resolveRemoteReadTarget(target, '/');
  const inside = (raw: string) => {
    const root = path.posix.normalize(raw);
    return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
  };
  if (protectedReadPaths.some((root) => typeof root === 'string' && root.startsWith('/') && inside(root)))
    throw new RemoteReadPolicyError('protected-resource', 'Protected path; read it yourself or change the rule first');
  if (CREDENTIAL.test(target) || SYSTEM_CREDENTIAL.test(target))
    throw new RemoteReadPolicyError('credential-resource', 'Credential file; AI cannot read its contents');
}
