import { describe, expect, it } from 'vitest';
import type { CommandAnalysis, OperationResult } from './model.js';
import { describeSudoOutcome, isSudoStatusProbe } from './sudo-outcome.js';
function analysis(args: string[]): CommandAnalysis {
  const call = { name: 'sudo', args, dynamic: false, redirects: false };
  return { raw: ['sudo', ...args].join(' '), calls: [call], steps: [{ call, condition: 'always' }],
    hasError: false, hasExpansion: false, hasPipeline: false, hasRedirection: false, hasCompound: false, redirectTargets: [] };
}
const result = (code: number, output: string): OperationResult => ({ operationId: 'op', status: code ? 'failed' : 'succeeded', exitCode: code, stdoutTail: output });
describe('sudo result interpretation from the deployment regression', () => {
  it('treats an earlier password typo followed by exit zero as authenticated success', () => {
    expect(describeSudoOutcome(analysis(['docker', 'network', 'ls']), result(0, 'Sorry, try again.\nNETWORK ID NAME\n'), 2))
      .toMatchObject({ status: 'succeeded', authentication: 'succeeded', authenticationAttempts: 2 });
  });
  it('does not turn lack of a non-interactive timestamp into rejected authentication', () => {
    expect(describeSudoOutcome(analysis(['-n', 'true']), result(1, 'sudo: a password is required\n'), 0))
      .toMatchObject({ authentication: 'required', failureKind: 'authentication-required', effects: 'none', requiresUserAction: false });
  });
  it('keeps actual authentication rejection blocked but leaves payload failures recoverable', () => {
    expect(describeSudoOutcome(analysis(['docker', 'ps']), result(1, 'sudo: 3 incorrect password attempts\n'), 3).requiresUserAction).toBe(true);
    expect(describeSudoOutcome(analysis(['docker', 'ps']), result(1, 'sudo: authentication failed\n'), 1).requiresUserAction).toBe(true);
    expect(describeSudoOutcome(analysis(['docker', 'ps']), result(1, 'sudo: PAM authentication error: Authentication failure\n'), 1).requiresUserAction).toBe(true);
    expect(describeSudoOutcome(analysis(['cat', '/missing']), result(1, 'cat: no such file'), 1).requiresUserAction).not.toBe(true);
    expect(describeSudoOutcome(analysis(['cat', '/missing']), result(1, 'sudo: cat: command not found'), 1).requiresUserAction).not.toBe(true);
  });
  it('recognizes only bounded diagnostic forms, never a business operation or wrapper', () => {
    for (const args of [['-n', '-l'], ['-l'], ['-v'], ['--non-interactive', '--list']]) expect(isSudoStatusProbe(analysis(args))).toBe(true);
    for (const args of [['-S', 'cat', '/root/file'], ['-n', 'docker', 'ps'], ['sh', '-c', 'id']]) expect(isSudoStatusProbe(analysis(args))).toBe(false);
    expect(isSudoStatusProbe({ ...analysis(['-l']), hasPipeline: true })).toBe(false);
  });
  it('retains authentication rejection for compound commands without caching their final exit as authentication proof', () => {
    const single = analysis(['docker', 'ps']);
    const compound = { ...single, hasCompound: true, steps: [...single.steps!, ...single.steps!] };
    expect(describeSudoOutcome(compound, result(1, 'sudo: 3 incorrect password attempts\n'), 3))
      .toMatchObject({ authentication: 'failed', requiresUserAction: true });
    expect(describeSudoOutcome(compound, result(0, 'finished'), 1).authentication).toBeUndefined();
  });
});
