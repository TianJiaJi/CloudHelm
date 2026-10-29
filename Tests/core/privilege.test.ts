import { describe, expect, it } from 'vitest';
import { sudoContextCommand, sudoTarget } from '../../packages/core/src/sudo-plan.js';
import { describeSudoOutcome } from '../../packages/core/src/sudo-outcome.js';
import type { CommandAnalysis, OperationResult } from '../../packages/core/src/model.js';
const analysis = (name: string, args: string[] = []): CommandAnalysis => {
  const call = { name, args, dynamic: false, redirects: false };
  const target = sudoTarget(call);
  return { raw: [name, ...args].join(' '), calls: target ? [call, { name: target.name, args: target.args, dynamic: false, redirects: false }] : [call], steps: [{ call, condition: 'always' }], redirectTargets: [],
    hasError: false, hasExpansion: false, hasPipeline: false, hasRedirection: false, hasCompound: false };
};
const failed = (text: string): OperationResult => ({ operationId: 'op', status: 'failed', exitCode: 1, effects: 'possible', stdoutTail: text });
describe('sudo context normalization before review', () => {
  it('wraps only literal commands before fingerprinting without granting a shell', () => {
    expect(sudoContextCommand(analysis('systemctl', ['restart', 'demo']))).toBe('sudo -- systemctl restart demo');
    expect(sudoContextCommand(analysis('sudo', ['-u', 'root', '--', 'id']))).toBe('sudo -u root -- id');
  });
  it('rejects other identities, probes, nested authentication and opaque syntax', () => {
    for (const value of [analysis('sudo', ['-u', 'other', 'id']), analysis('sudo', ['-n', 'true']), analysis('su', ['root']),
      { ...analysis('id'), hasExpansion: true }, { ...analysis('id'), hasPipeline: true }, { ...analysis('id'), hasCompound: true }])
      expect(() => sudoContextCommand(value)).toThrow();
  });
});
describe('bounded privilege feedback, not authoritative inference from payload text', () => {
  it.each([
    ['sudo: 3 incorrect password attempts', 'authentication-rejected', 'authentication'],
    ['sudo: tian is not in the sudoers file.', 'authorization-denied', 'authorization'],
    ['sudo: user tian is not allowed to execute this command', 'authorization-denied', 'authorization'],
    ['tian is not in the sudoers file. This incident will be reported.', 'authorization-denied', 'authorization'],
    ['Sorry, user tian may not run sudo on fixture.', 'authorization-denied', 'authorization'],
    ["Sorry, user tian is not allowed to execute '/usr/bin/id' as root on fixture.", 'authorization-denied', 'authorization'],
    ['sudo: PAM authentication error: Authentication failure', 'authentication-unconfirmed', 'authentication']
  ])('distinguishes %s without claiming no business effects', (text, code, stage) => {
    const result = describeSudoOutcome(analysis('sudo', ['id']), failed(text), 3);
    expect(result.privilege).toMatchObject({ method: 'sudo', code, stage, source: 'output-inference', businessCommand: 'unknown' });
    expect(result.effects).toBe('possible'); expect(result.requiresUserAction).toBe(true);
  });
  it('does not clear possible write effects from a spoofed non-interactive sudo diagnostic', () => {
    const result = describeSudoOutcome(analysis('sudo', ['-n', 'touch', '/opt/fixture']), failed('sudo: a password is required\n'), 0);
    expect(result).toMatchObject({ effects: 'possible', authentication: 'required', requiresUserAction: false,
      privilege: { source: 'output-inference', businessCommand: 'unknown' } });
  });
  it('preserves transport-confirmed cancellation and never treats unknown exit as a retryable password failure', () => {
    const result: OperationResult = { ...failed('sudo: 3 incorrect password attempts'), status: 'unknown', exitCode: undefined };
    expect(describeSudoOutcome(analysis('sudo', ['id']), result, 3).privilege).toBeUndefined();
    const confirmed = { ...failed(''), privilege: { method: 'sudo' as const, code: 'cancelled' as const, stage: 'authentication' as const,
      source: 'transport' as const, businessCommand: 'unknown' as const, recovery: 'user-action' as const } };
    expect(describeSudoOutcome(analysis('sudo', ['id']), confirmed, 1).privilege).toEqual(confirmed.privilege);
  });
});
