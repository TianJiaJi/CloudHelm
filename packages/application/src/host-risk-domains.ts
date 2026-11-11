import { assertRiskIdentity, type HostRiskBinding } from '@cloudhelm/core';

/** Immutable host-to-risk bindings. No credentials, approvals, or execution recipients are aliased. */
export class HostRiskDomains {
  private bindings = new Map<string, string>();
  private members = new Map<string, Set<string>>();

  domain(hostId: string): string { return this.bindings.get(hostId) ?? hostId; }
  peers(hostId: string): Set<string> {
    const domain = this.domain(hostId);
    // An absent ancestor can still own a restored unresolved operation.
    return new Set([hostId, domain, ...this.members.get(domain) ?? []]);
  }
  bind(values: readonly HostRiskBinding[], active: (hostId: string) => boolean): void {
    const next = new Map(this.bindings);
    for (const { hostId, riskDomainId } of values) {
      assertRiskIdentity(hostId); assertRiskIdentity(riskDomainId);
      const existing = next.get(hostId);
      if (existing !== undefined && existing !== riskDomainId) throw new Error('Host risk binding cannot be replaced');
      if (this.domain(hostId) !== riskDomainId && [...this.peers(hostId)].some(active)) {
        throw new Error('Cannot change a host risk binding while work is queued or running');
      }
      next.set(hostId, riskDomainId);
    }
    for (const domain of next.values()) {
      if (next.has(domain) && next.get(domain) !== domain) throw new Error('Host risk bindings must name a stable root');
    }
    const members = new Map<string, Set<string>>();
    for (const [hostId, domain] of next) {
      const group = members.get(domain) ?? new Set<string>(); group.add(hostId); members.set(domain, group);
    }
    // Validate the whole batch before publishing anything; existing locks are never moved or dropped.
    this.bindings = next; this.members = members;
  }
}
