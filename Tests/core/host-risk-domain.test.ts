import { describe, expect, it } from 'vitest';
import { resolveHostRiskDomain, type HostRiskIdentity } from '@cloudhelm/core';

describe('backend host revision risk lineage', () => {
  it('uses the original identity across several connection/login revisions', () => {
    const hosts = new Map<string, HostRiskIdentity>([
      ['original', { id: 'original' }], ['middle', { id: 'middle', previousHostId: 'original' }],
      ['latest', { id: 'latest', previousHostId: 'middle' }]
    ]);
    expect(resolveHostRiskDomain(hosts.get('latest')!, (id) => hosts.get(id))).toBe('original');
    expect(resolveHostRiskDomain(hosts.get('middle')!, (id) => hosts.get(id))).toBe('original');
  });
  it('retains an absent predecessor as an anchor rather than silently starting a new domain', () => {
    expect(resolveHostRiskDomain({ id: 'latest', previousHostId: 'missing' }, () => undefined)).toBe('missing');
  });
  it('rejects cyclic, malformed and inconsistent lineage without echoing record contents', () => {
    const a = { id: 'a', previousHostId: 'b' }, b = { id: 'b', previousHostId: 'a' };
    expect(() => resolveHostRiskDomain(a, (id) => id === 'a' ? a : b)).toThrow('Invalid host risk lineage');
    expect(() => resolveHostRiskDomain({ id: 'a', previousHostId: 'a' }, () => undefined)).toThrow();
    expect(() => resolveHostRiskDomain(a, () => ({ id: 'wrong-record' }))).toThrow();
    expect(() => resolveHostRiskDomain({ id: 'synthetic\nprivate-value' }, () => undefined)).toThrow('Invalid host risk identity');
  });
  it('does not infer aliases from an address, host key or login name', () => {
    const a = { id: 'a', address: 'same.invalid', fingerprint: 'synthetic', username: 'same' };
    const b = { ...a, id: 'b' };
    expect(resolveHostRiskDomain(a, () => b)).toBe('a');
    expect(resolveHostRiskDomain(b, () => a)).toBe('b');
  });
});
