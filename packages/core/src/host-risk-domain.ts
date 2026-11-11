/** Connection revisions remain distinct; only backend-owned lineage defines this risk identity. */
export interface HostRiskIdentity { id: string; previousHostId?: string }
export interface HostRiskBinding { hostId: string; riskDomainId: string }

export function assertRiskIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error('Invalid host risk identity');
  }
}

/** Pure derivation from existing durable lineage, without DNS/IP/fingerprint guesses or credential reads. */
export function resolveHostRiskDomain(host: HostRiskIdentity, lookup: (id: string) => HostRiskIdentity | undefined): string {
  return deriveDomain(host, lookup, new Map());
}

/** One local memo per projection: linear graph lookup, no stale cross-snapshot identities. */
export function resolveHostRiskBindings(hosts: ReadonlyMap<string, HostRiskIdentity>): HostRiskBinding[] {
  for (const [id, host] of hosts) if (id !== host.id) throw new Error('Invalid host risk lineage');
  const memo = new Map<string, { root: string; depth: number }>();
  return [...hosts.values()].map((host) => ({ hostId: host.id,
    riskDomainId: deriveDomain(host, (id) => hosts.get(id), memo) }));
}

function deriveDomain(host: HostRiskIdentity, lookup: (id: string) => HostRiskIdentity | undefined,
  memo: Map<string, { root: string; depth: number }>): string {
  const seen = new Set<string>();
  let current = host, root: string, depth = 0;
  while (true) {
    assertRiskIdentity(current.id);
    if (seen.has(current.id) || seen.size >= 10_000) throw new Error('Invalid host risk lineage');
    const cached = memo.get(current.id);
    if (cached) { root = cached.root; depth = cached.depth; break; }
    seen.add(current.id);
    if (current.previousHostId === undefined) { root = current.id; break; }
    assertRiskIdentity(current.previousHostId);
    if (seen.has(current.previousHostId)) throw new Error('Invalid host risk lineage');
    const previous = lookup(current.previousHostId);
    // The durable predecessor ID remains a conservative anchor even if its profile is absent.
    if (!previous) { root = current.previousHostId; break; }
    if (previous.id !== current.previousHostId) throw new Error('Invalid host risk lineage');
    current = previous;
  }
  // Cached suffixes must not bypass the same depth bound as a single-host walk.
  if (seen.size + depth > 10_000) throw new Error('Invalid host risk lineage');
  for (const id of [...seen].reverse()) memo.set(id, { root, depth: ++depth });
  return root;
}
