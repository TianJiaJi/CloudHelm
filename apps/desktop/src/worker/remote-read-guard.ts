import path from 'node:path';

/** Reads for the model's edit loop are a separate capability from command review,
 * so the same boundaries must be enforced here: resolved literals only, never a
 * user-protected tree, never a credential file. Reading also never elevates. */
const CREDENTIAL = /(?:^|\/)(?:\.ssh\/(?:id_[^/]+|authorized_keys)|\.env(?:\.[^/]+)?|\.Xauthority(?:-[^/]*)?)$/u;
const SYSTEM_CREDENTIAL = /^\/(?:etc\/(?:shadow|gshadow)|root\/\.ssh\/)/u;

export function resolveRemoteReadTarget(filePath: string, cwd: string | undefined): string {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) throw new Error('Invalid remote read path');
  if (/[\u0000-\u001f\u007f]/u.test(filePath)) throw new Error('Invalid remote read path');
  const target = filePath.startsWith('/') ? path.posix.normalize(filePath) : path.posix.resolve(cwd ?? '/', filePath);
  if (!target.startsWith('/') || target.split('/').includes('..')) throw new Error('Invalid remote read path');
  return target;
}

export function assertRemoteReadAllowed(target: string, protectedReadPaths: readonly string[]): void {
  const inside = (root: string) => target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
  if (protectedReadPaths.some((root) => typeof root === 'string' && root.startsWith('/') && inside(root)))
    throw new Error('Protected path; read it yourself or change the rule first');
  if (CREDENTIAL.test(target) || SYSTEM_CREDENTIAL.test(target))
    throw new Error('Credential file; AI cannot read its contents');
}
