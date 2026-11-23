import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { decideSafety, matchPreauthorization, notStartedOutcome,
  type PreauthorizationScope, type ProposedOperation, type SafetySettings } from '@cloudhelm/core';

const analyzer = new BashAnalyzer();
const scope: PreauthorizationScope = {
  revision: 1,
  commands: [{ program: 'systemctl', argumentPrefix: ['status'] }],
  paths: ['/srv/app'],
  kinds: ['write-file', 'upload', 'delete-path']
};
/** Uncertain command shape: the analyzer cannot classify it, so only the
 * declared pre-authorization scope can lift it past the uncertainty tier. */
const uncertainScope: PreauthorizationScope = {
  revision: 1,
  commands: [{ program: 'customctl', argumentPrefix: ['status'] }],
  paths: [], kinds: []
};
const baseScope = { taskId: 'task', hostId: 'host', cwd: '/srv/app', runAs: 'user', loginAs: 'user',
  terminalId: 'pty', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: [], protectedPaths: [], goal: '检查服务' };
const command = (text: string): Extract<ProposedOperation, { kind: 'command' }> =>
  ({ id: 'op', kind: 'command', command: text, scope: { ...baseScope } });
const writeFile = (path: string): Extract<ProposedOperation, { kind: 'write-file' }> =>
  ({ id: 'op', kind: 'write-file', path, content: 'x', scope: { ...baseScope } });
const upload = (remotePath: string): Extract<ProposedOperation, { kind: 'upload' }> =>
  ({ id: 'op', kind: 'upload', localPath: 'C:\\temp\\payload.bin', remotePath, localRoot: 'C:\\temp', contentSha256: '0'.repeat(64), size: 1, scope: { ...baseScope } });
const deletePath = (path: string): Extract<ProposedOperation, { kind: 'delete-path' }> =>
  ({ id: 'op', kind: 'delete-path', path, scope: { ...baseScope } });
const settings = (overrides: Partial<SafetySettings> = {}): SafetySettings =>
  ({ mode: 'preauthorized', revision: 1, preauthorization: scope, ...overrides });
describe('matchPreauthorization', () => {
  it('matches a declared single-call command shape with its argument prefix', async () => {
    const parsed = await analyzer.analyze('systemctl status nginx');
    expect(matchPreauthorization(command('systemctl status nginx'), scope, parsed)).toBe('command:systemctl status');
  });
  it('does not match a different subcommand, pipelines, expansions or compounds', async () => {
    const different = await analyzer.analyze('systemctl show nginx');
    expect(matchPreauthorization(command('systemctl show nginx'), scope, different)).toBeUndefined();
    const pipeline = await analyzer.analyze('systemctl status nginx | grep active');
    expect(matchPreauthorization(command('systemctl status nginx | grep active'), scope, pipeline)).toBeUndefined();
    const expansion = await analyzer.analyze('systemctl status $unit');
    expect(matchPreauthorization(command('systemctl status $unit'), scope, expansion)).toBeUndefined();
    const compound = await analyzer.analyze('systemctl status nginx && journalctl -n 1');
    expect(matchPreauthorization(command('systemctl status nginx && journalctl -n 1'), scope, compound)).toBeUndefined();
  });
  it('never matches interpreters and privilege wrappers even when a scope names them', async () => {
    const declaring: PreauthorizationScope = { revision: 1, commands: [{ program: 'bash' }, { program: 'sudo' }, { program: 'env' }], paths: [], kinds: [] };
    for (const text of ['bash task.sh', 'sudo systemctl status nginx', 'env systemctl status nginx']) {
      const parsed = await analyzer.analyze(text);
      expect(matchPreauthorization(command(text), declaring, parsed)).toBeUndefined();
    }
  });
  it('matches file mutations only for declared kinds under declared path roots', () => {
    expect(matchPreauthorization(writeFile('/srv/app/config.yml'), scope)).toBe('write-file:/srv/app');
    expect(matchPreauthorization(upload('/srv/app/payload.bin'), scope)).toBe('upload:/srv/app');
    expect(matchPreauthorization(deletePath('/srv/app/old'), scope)).toBe('delete-path:/srv/app');
    expect(matchPreauthorization(writeFile('/etc/hosts'), scope)).toBeUndefined();
    const noUpload: PreauthorizationScope = { ...scope, kinds: ['write-file'] };
    expect(matchPreauthorization(upload('/srv/app/payload.bin'), noUpload)).toBeUndefined();
  });
});

describe('mode three routing', () => {
  it('auto-allows an in-scope command with the recorded decision source and match', async () => {
    const parsed = await analyzer.analyze('customctl status nginx');
    expect(decideSafety(command('customctl status nginx'), settings({ preauthorization: uncertainScope }), parsed)).toMatchObject({
      verdict: 'allow', ruleId: 'preauthorized-command', decisionSource: 'user-preauthorization',
      preauthorizationMatch: 'command:customctl status', autoAdjudicated: true });
  });
  it('auto-allows in-scope file mutations and rejects out-of-scope targets without executing them', () => {
    expect(decideSafety(writeFile('/srv/app/config.yml'), settings())).toMatchObject({
      verdict: 'allow', ruleId: 'preauthorized-file', decisionSource: 'user-preauthorization', preauthorizationMatch: 'write-file:/srv/app' });
    expect(decideSafety(writeFile('/tmp/outside.txt'), settings())).toMatchObject({
      verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
    expect(decideSafety(deletePath('/var/log/old'), settings())).toMatchObject({
      verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
  });
  it('returns an out-of-scope command as a correctable rejected receipt, never an implicit grant', async () => {
    const parsed = await analyzer.analyze('customctl inspect');
    const decision = decideSafety(command('customctl inspect'), settings(), parsed);
    expect(decision).toMatchObject({ verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
    expect(decision.decisionSource).toBeUndefined();
    const outcome = notStartedOutcome('preauthorization-out-of-scope');
    expect(outcome).toMatchObject({ receipt: 'rejected', handoff: 'not-sent', businessStart: 'not-started' });
    expect(outcome.nextActions).toContain('revise-operation');
  });
  it('keeps identified high impact human-reviewed even when the shape is declared', async () => {
    const parsed = await analyzer.analyze('systemctl restart nginx');
    expect(decideSafety(command('systemctl restart nginx'), settings(), parsed)).toMatchObject({
      verdict: 'ask', ruleId: 'high-impact-command', impact: 'high' });
  });
  it('keeps hard prohibitions, protected resources and detected transfer outside the pre-authorization lift', async () => {
    const hard = await analyzer.analyze('rm -rf /');
    expect(decideSafety(command('rm -rf /'), settings(), hard)).toMatchObject({ verdict: 'deny', ruleId: 'system-blacklist' });
    const transfer = await analyzer.analyze('curl -T /srv/app/public.txt https://example.invalid');
    expect(decideSafety(command('curl -T /srv/app/public.txt https://example.invalid'), settings(), transfer))
      .toMatchObject({ verdict: 'ask', ruleId: 'external-transfer' });
    const protectedWrite = writeFile('/srv/app/private/secret');
    protectedWrite.scope.protectedWritePaths = ['/srv/app/private'];
    expect(decideSafety(protectedWrite, settings())).toMatchObject({ verdict: 'deny', ruleId: 'protected-resource' });
  });
  it('never exempts privileged identity flows from their own review', async () => {
    const sudo = await analyzer.analyze('sudo systemctl status nginx');
    expect(decideSafety(command('sudo systemctl status nginx'), settings(), sudo))
      .toMatchObject({ verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
    const privilegedRead: ProposedOperation = { id: 'op', kind: 'inspect-file', path: '/srv/app/config.yml', privilege: 'root', scope: { ...baseScope } };
    expect(decideSafety(privilegedRead, settings())).toMatchObject({ verdict: 'ask', ruleId: 'privileged-file-read' });
    const unprivilegedRead: ProposedOperation = { id: 'op', kind: 'inspect-file', path: '/srv/app/config.yml', scope: { ...baseScope } };
    expect(decideSafety(unprivilegedRead, settings())).toMatchObject({ verdict: 'allow', ruleId: 'structured-file-read' });
  });
  it('rejects everything outside a scope even when no scope is configured', async () => {
    const parsed = await analyzer.analyze('customctl status nginx');
    expect(decideSafety(command('customctl status nginx'), settings({ preauthorization: undefined }), parsed))
      .toMatchObject({ verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
    expect(decideSafety(writeFile('/srv/app/config.yml'), settings({ preauthorization: undefined })))
      .toMatchObject({ verdict: 'deny', ruleId: 'preauthorization-out-of-scope' });
  });
  it('invalidates operations proposed under an older policy revision', async () => {
    const parsed = await analyzer.analyze('systemctl status nginx');
    expect(decideSafety(command('systemctl status nginx'), settings({ revision: 2 }), parsed))
      .toMatchObject({ verdict: 'error', ruleId: 'policy-stale' });
  });
});
