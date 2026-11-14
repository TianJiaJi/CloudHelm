import path from 'node:path';

/** Shared conservative defaults for structured reads and recognized shell reads.
 * Extensions such as PEM can also hold public material: default denial is deliberate.
 * Arbitrary application secrets still require user-configured protected read paths. */
export function isSensitiveReadPath(value: string): boolean {
  const target = path.posix.normalize(value);
  const name = path.posix.basename(target);
  if (target === '/etc/shadow' || target === '/etc/gshadow') return true;
  if (target.startsWith('/root/.ssh/')) return true;
  if (/^\.env(?:\..*)?$/u.test(name) || /^\.?Xauthority(?:-[^/]*)?$/u.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx|ppk)(?:\.(?:bak|backup|old|\d+))?$/iu.test(name)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:_sk)?(?:[.-].*)?$/iu.test(name)) return true;
  return /(?:^|\/)\.ssh\/(?:id_[^/]+|identity(?:\.[^/]+)?|authorized_keys)$/u.test(target);
}
