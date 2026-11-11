import { expect, it, vi } from 'vitest';
import { resolveHostRiskBindings, type HostRiskIdentity } from '@cloudhelm/core';

function chain(count: number): Map<string, HostRiskIdentity> {
  return new Map(Array.from({ length: count }, (_, index) => {
    const id = `host-${index}`;
    return [id, { id, ...(index ? { previousHostId: `host-${index - 1}` } : {}) }] as const;
  }));
}

it.each([true, false])('projects a long chain with linear parent lookups in reverse order=%s', (reverse) => {
  const original = chain(2000), hosts = reverse ? new Map([...original].reverse()) : original;
  const lookup = vi.spyOn(hosts, 'get');
  const bindings = resolveHostRiskBindings(hosts);
  expect(bindings).toHaveLength(2000); expect(bindings.every((binding) => binding.riskDomainId === 'host-0')).toBe(true);
  expect(lookup.mock.calls.length).toBeLessThanOrEqual(2000);
});

it('never reuses a memo across snapshots or ignores corrupted graph entries', () => {
  const hosts = chain(3);
  expect(resolveHostRiskBindings(hosts).at(-1)?.riskDomainId).toBe('host-0');
  hosts.set('host-0', { id: 'host-0', previousHostId: 'missing-ancestor' });
  expect(resolveHostRiskBindings(hosts).every((binding) => binding.riskDomainId === 'missing-ancestor')).toBe(true);
  hosts.set('host-0', { id: 'host-0', previousHostId: 'host-2' });
  expect(() => resolveHostRiskBindings(hosts)).toThrow('Invalid host risk lineage');
  hosts.set('host-0', { id: 'wrong-record' });
  expect(() => resolveHostRiskBindings(hosts)).toThrow('Invalid host risk lineage');
});

it('does not bypass the depth limit using previously cached suffixes', () => {
  const hosts = chain(10_000);
  expect(resolveHostRiskBindings(hosts)).toHaveLength(10_000);
  hosts.set('too-deep', { id: 'too-deep', previousHostId: 'host-9999' });
  expect(() => resolveHostRiskBindings(hosts)).toThrow('Invalid host risk lineage');
});
