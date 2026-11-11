import { expect, it } from 'vitest';
import { sharesHostRiskDomain } from '@cloudhelm/contracts';

it('projects backend bindings, including a retained absent ancestor, without inventing aliases', () => {
  const bindings = [{ hostId: 'current', riskDomainId: 'original' }];
  expect(sharesHostRiskDomain(bindings, 'current', 'original')).toBe(true);
  expect(sharesHostRiskDomain(bindings, 'current', 'unrelated')).toBe(false);
  expect(sharesHostRiskDomain(undefined, 'current', 'original')).toBe(false);
  expect(sharesHostRiskDomain(undefined, 'current', 'current')).toBe(true);
});

it('does not use ambiguous or empty projected bindings to associate different configurations', () => {
  expect(sharesHostRiskDomain([{ hostId: 'current', riskDomainId: 'original' },
    { hostId: 'current', riskDomainId: 'different' }], 'current', 'original')).toBe(false);
  expect(sharesHostRiskDomain([{ hostId: 'current', riskDomainId: '' },
    { hostId: 'original', riskDomainId: '' }], 'current', 'original')).toBe(false);
});
