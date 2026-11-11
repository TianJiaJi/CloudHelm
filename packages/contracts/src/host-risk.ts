/** Backend-computed projection; never inferred by the renderer from addresses or host keys. */
export interface HostRiskBindingView { hostId: string; riskDomainId: string }

/** Shared risk is neither an execution permission nor proof of an equivalent observation recipient. */
export function sharesHostRiskDomain(bindings: readonly HostRiskBindingView[] | undefined, left: string, right: string): boolean {
  if (left === right) return true;
  const domain = (id: string): string | undefined => {
    const matches = bindings?.filter((binding) => binding.hostId === id) ?? [];
    if (!matches.length) return id; // Legacy exact identity, including an absent ancestor.
    if (matches.length !== 1 || typeof matches[0]!.riskDomainId !== 'string' || !matches[0]!.riskDomainId.trim()) return undefined;
    return matches[0]!.riskDomainId;
  };
  const first = domain(left);
  return first !== undefined && first === domain(right);
}
