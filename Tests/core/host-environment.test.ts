import { expect, it } from 'vitest';
import { architectureFamilyOf } from '../../packages/core/src/host-environment.js';

it('normalizes kernel architecture aliases through the fixed table only', () => {
  expect(architectureFamilyOf('x86_64')).toBe('x86_64');
  expect(architectureFamilyOf('amd64')).toBe('x86_64');
  expect(architectureFamilyOf('aarch64')).toBe('aarch64');
  expect(architectureFamilyOf('arm64')).toBe('aarch64');
  expect(architectureFamilyOf('armv7l')).toBe('arm32');
  expect(architectureFamilyOf('i686')).toBe('x86');
  expect(architectureFamilyOf('riscv64')).toBe('riscv64');
  expect(architectureFamilyOf('loongarch64')).toBe('loongarch64');
});

it('keeps unknown and missing architectures unknown instead of guessing a family', () => {
  expect(architectureFamilyOf('mystery-arch')).toBeNull();
  expect(architectureFamilyOf('')).toBeNull();
  expect(architectureFamilyOf(null)).toBeNull();
});
