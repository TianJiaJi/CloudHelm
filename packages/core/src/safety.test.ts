import { describe, expect, it } from 'vitest';
import type { CommandAnalysis, CommandCall, OperationScope, ProposedOperation, ReviewMode, SafetySettings } from './model.js';
import { decideSafety, inspectScriptSafety } from './safety.js';

const call = (name: string, args: string[] = [], dynamic = false): CommandCall => ({ name, args, dynamic, redirects: false });

const analysis = (calls: CommandCall[], over: Partial<CommandAnalysis> = {}): CommandAnalysis => ({
  calls, redirectTargets: [], hasExpansion: false, hasPipeline: false,
  hasCompound: false, hasRedirection: false, hasError: false, raw: '', ...over
});

const scope = (over: Partial<OperationScope> = {}): OperationScope => ({
  taskId: 'task', hostId: 'host', cwd: '/home/tian', runAs: 'tian', terminalId: 'pty',
  terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/home/tian'],
  protectedPaths: [], goal: '完成用户请求的目录与文件创建', ...over
});

const command = (raw: string, over: Partial<OperationScope> = {}): Extract<ProposedOperation, { kind: 'command' }> =>
  ({ id: 'op', kind: 'command', command: raw, scope: scope(over) });

const write = (path: string, over: Partial<OperationScope> = {}): ProposedOperation =>
  ({ id: 'op', kind: 'write-file', path, content: 'x', scope: scope(over) });

const settings = (mode: ReviewMode): SafetySettings => ({ mode, revision: 1 });

const modes: ReviewMode[] = ['ask', 'ai-review', 'permissive'];

/** [mode, expected verdict] for identified high-impact routing. */
const tier: Array<[ReviewMode, 'ask' | 'evaluate']> = [
  ['ask', 'ask'],
  ['ai-review', 'evaluate'],
  ['permissive', 'ask']
];

describe('three-tier review matrix', () => {
  it.each(modes)('low-risk mkdir is allowed in %s', (mode) => {
    const operation = command('mkdir -p /home/tian/test');
    expect(decideSafety(operation, settings(mode), analysis([call('mkdir', ['-p', '/home/tian/test'])])))
      .toMatchObject({ verdict: 'allow', ruleId: 'low-risk-command' });
  });

  it.each(tier)('in %s mode an identified high-impact command resolves to %s', (mode, verdict) => {
    const operation = command('useradd demo');
    expect(decideSafety(operation, settings(mode), analysis([call('useradd', ['demo'])])))
      .toMatchObject({ verdict, ruleId: 'high-impact-command', impact: 'high' });
  });

  it.each(tier)('in %s mode a security-configuration file change resolves to %s', (mode, verdict) => {
    expect(decideSafety(write('/etc/ssh/sshd_config'), settings(mode)))
      .toMatchObject({ verdict, ruleId: 'high-impact-file', impact: 'high' });
  });

  it.each([
    ['ask', 'ask', 'uncertain-command'],
    ['ai-review', 'evaluate', 'uncertain-command'],
    ['permissive', 'allow', 'permissive-mode']
  ] as const)('in %s mode an opaque command resolves to %s (%s)', (mode, verdict, ruleId) => {
    const dynamic = [call('run', ['$TARGET'], true)];
    expect(decideSafety(command('run $TARGET'), settings(mode), analysis(dynamic, { hasExpansion: true })))
      .toMatchObject({ verdict, ruleId });
  });

  it.each(modes)('a hard prohibition is always denied in %s', (mode) => {
    const rm = [call('rm', ['-rf', '/'])];
    expect(decideSafety(command('rm -rf /'), settings(mode), analysis(rm, { raw: 'rm -rf /' })))
      .toMatchObject({ verdict: 'deny', ruleId: 'system-blacklist' });
  });

  it.each(modes)('a user-protected path is always denied in %s', (mode) => {
    expect(decideSafety(write('/srv/data/config.yaml', { protectedWritePaths: ['/srv/data'] }), settings(mode)))
      .toMatchObject({ verdict: 'deny', ruleId: 'protected-resource' });
  });

  it.each(modes)('a protected command target is always denied in %s', (mode) => {
    const rm = [call('rm', ['-rf', '/srv/data'])];
    expect(decideSafety(command('rm -rf /srv/data', { protectedWritePaths: ['/srv/data'] }),
      settings(mode), analysis(rm, { raw: 'rm -rf /srv/data' }))).toMatchObject({ verdict: 'deny', ruleId: 'protected-resource' });
  });
});

describe('inspected script risk is preserved per tier', () => {
  const operation = command('sh ./install.sh');

  it.each(tier)('in %s mode a high-impact script resolves to %s and never auto-allows', (mode, verdict) => {
    expect(inspectScriptSafety(operation, 'useradd demo', analysis([call('useradd', ['demo'])]), settings(mode)))
      .toMatchObject({ verdict, ruleId: 'high-impact-script', impact: 'high' });
  });

  it.each([
    ['ask', 'ask', 'script-uncertain'],
    ['ai-review', 'evaluate', 'script-uncertain'],
    ['permissive', 'allow', 'permissive-script']
  ] as const)('in %s mode an opaque script resolves to %s (%s)', (mode, verdict, ruleId) => {
    expect(inspectScriptSafety(operation, 'eval $CMD', analysis([call('eval', ['$CMD'])], { hasExpansion: true }), settings(mode)))
      .toMatchObject({ verdict, ruleId });
  });

  it.each(modes)('a bounded script is allowed in %s', (mode) => {
    expect(inspectScriptSafety(operation, 'mkdir -p /home/tian/test', analysis([call('mkdir', ['-p', '/home/tian/test'])]), settings(mode)))
      .toMatchObject({ verdict: 'allow', ruleId: 'inspected-script' });
  });

  it('keeps a hard prohibition from the script source in every tier', () => {
    expect(inspectScriptSafety(operation, 'rm -rf /', analysis([call('rm', ['-rf', '/'])], { raw: 'rm -rf /' }), settings('permissive')))
      .toMatchObject({ verdict: 'deny', ruleId: 'system-blacklist' });
  });
});
