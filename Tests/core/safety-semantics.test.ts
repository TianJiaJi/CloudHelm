import { expect, it } from 'vitest';
import type { CommandAnalysis, CommandCall, CommandContext, OperationScope, ReviewMode } from '../../packages/core/src/model.js';
import { decideSafety, isEffectFreeQuery, scriptFilePath } from '../../packages/core/src/safety.js';

const scope: OperationScope = { taskId: 'task', hostId: 'fixture', cwd: '/srv/app', runAs: 'deploy',
  terminalId: 'fixture', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Maintenance' };
const context: CommandContext = { cwd: { state: 'known', changes: [] }, namespace: 'inherited', identity: { state: 'inherited' }, unknownReasons: [] };
function analysis(call: CommandCall): CommandAnalysis {
  return { calls: [call], raw: '', redirectTargets: [], hasExpansion: false, hasPipeline: false,
    hasCompound: false, hasRedirection: false, hasError: false };
}
it.each(['ask', 'ai-review', 'permissive'] as const)('does not treat legacy family metadata as ordinary in %s', (mode) => {
  for (const [name, args] of [['git', ['-C', '/srv/app', 'reset', '--hard']], ['tar', ['-cf', '/dev/sda', 'data']]] as const) {
    const value = analysis({ name, args: [...args], dynamic: false, redirects: false });
    const result = decideSafety({ id: 'op', kind: 'command', command: value.raw, scope }, { mode, revision: 1 }, value);
    expect(result.ruleId).not.toBe('ordinary-command');
    expect(result.verdict).toBe(mode === 'ai-review' ? 'evaluate' : mode === 'ask' ? 'ask' : 'allow');
  }
});
it('retains a known high-impact classification for legacy direct reset and partial new metadata', () => {
  const call: CommandCall = { name: 'git', args: ['reset', '--hard'], dynamic: false, redirects: false };
  const decide = (mode: ReviewMode) => decideSafety({ id: 'op', kind: 'command', command: '', scope }, { mode, revision: 1 }, analysis(call));
  expect(decide('permissive')).toMatchObject({ verdict: 'ask', impact: 'high' });
  call.semantics = { coverage: 'partial', unknownReasons: ['Config not inspected'], git: {
    subcommand: 'reset', args: ['--hard'], directory: context.cwd, paths: [] } };
  expect(decide('ai-review')).toMatchObject({ verdict: 'evaluate', impact: 'high' });
});
it('does not make an unknown-directory query effect-free', () => {
  const call: CommandCall = { name: 'ls', args: [], dynamic: false, redirects: false,
    context: { ...context, cwd: { state: 'unknown' } } };
  expect(isEffectFreeQuery(analysis(call))).toBe(false);
});
it('does not inspect a script using the entry directory after a launcher changes cwd', () => {
  const call: CommandCall = { name: 'sh', args: ['./deploy.sh'], dynamic: false, redirects: false, context };
  expect(scriptFilePath(analysis(call))).toBe('./deploy.sh');
  call.context = { ...context, cwd: { state: 'known', changes: ['/other'] } };
  expect(scriptFilePath(analysis(call))).toBeUndefined();
});
