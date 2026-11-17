import { expect, it } from 'vitest';
import { resolveHostRiskBindings, resolveHostRiskDomain, type HostRiskIdentity } from '@cloudhelm/core';

const graph = (hosts: HostRiskIdentity[]) => new Map(hosts.map((host) => [host.id, host] as const));
const domain = (hosts: Map<string, HostRiskIdentity>, id: string) =>
  resolveHostRiskDomain(hosts.get(id)!, (key) => hosts.get(key));

it('associates a duplicate configuration with the existing target record', () => {
  const hosts = graph([{ id: 'original' }, { id: 'duplicate', riskPeerHostId: 'original' }]);
  expect(resolveHostRiskBindings(hosts)).toEqual([
    { hostId: 'original', riskDomainId: 'original' },
    { hostId: 'duplicate', riskDomainId: 'original' }]);
});

it('keeps the association through a target-unchanged revision of the duplicate', () => {
  const hosts = graph([{ id: 'original' },
    { id: 'duplicate', riskPeerHostId: 'original' },
    { id: 'revised', previousHostId: 'duplicate', riskPeerHostId: 'original' }]);
  expect(domain(hosts, 'revised')).toBe('original');
});

it('follows the recorded lineage before any association on a revision', () => {
  const hosts = graph([{ id: 'original' },
    { id: 'duplicate', riskPeerHostId: 'original' },
    { id: 'other-target' },
    { id: 'moved', previousHostId: 'duplicate', riskPeerHostId: 'other-target' }]);
  expect(domain(hosts, 'moved')).toBe('original');
  // Every domain id must be a stable root: present in the graph and bound to itself.
  for (const binding of resolveHostRiskBindings(hosts)) {
    expect(domain(hosts, binding.riskDomainId)).toBe(binding.riskDomainId);
  }
});

it('keeps a target-changed revision inside its lineage domain conservatively', () => {
  const hosts = graph([{ id: 'original' },
    { id: 'duplicate', riskPeerHostId: 'original' },
    // No new association: the revision cannot escape its lineage's unresolved risk by editing.
    { id: 'moved', previousHostId: 'duplicate' }]);
  expect(domain(hosts, 'moved')).toBe('original');
});

it('treats an absent association target as the conservative shared anchor', () => {
  const hosts = graph([{ id: 'duplicate', riskPeerHostId: 'gone' }]);
  expect(resolveHostRiskBindings(hosts)).toEqual([{ hostId: 'duplicate', riskDomainId: 'gone' }]);
});

it('rejects forged association cycles and self references', () => {
  const mutual = graph([{ id: 'a', riskPeerHostId: 'b' }, { id: 'b', riskPeerHostId: 'a' }]);
  expect(() => resolveHostRiskBindings(mutual)).toThrow('Invalid host risk lineage');
  const self = graph([{ id: 'a', riskPeerHostId: 'a' }]);
  expect(() => resolveHostRiskBindings(self)).toThrow('Invalid host risk lineage');
});
