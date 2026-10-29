import { expect, it, vi } from 'vitest';
import { operationFingerprint, type CommandAnalysis, type CommandCall, type CommandContext, type ProposedOperation,
  type ReviewMode } from '@cloudhelm/core';
import { SafetyGate } from '../../packages/application/src/safety-gate.js';

const context: CommandContext = { cwd: { state: 'known', changes: [] }, identity: { state: 'inherited' }, namespace: 'inherited', unknownReasons: [] };
const operation = (command: string): Extract<ProposedOperation, { kind: 'command' }> => ({ id: 'fixture', kind: 'command', command, scope: {
  taskId: 'task', hostId: 'fixture', cwd: '/srv/app', runAs: 'deploy', terminalId: 'fixture', terminalGeneration: 1,
  policyRevision: 1, allowedWorkingRoots: ['/srv/app'], protectedPaths: [], goal: 'Maintenance'
} });
function fixture(raw: string, calls: CommandCall[], mode: ReviewMode) {
  let generation = 1;
  const parsed: CommandAnalysis = { calls, raw, redirectTargets: [], redirectEffects: [], scopedContexts: true,
    hasExpansion: false, hasPipeline: false, hasCompound: calls.length > 1, hasRedirection: false, hasError: false };
  const execute = vi.fn(async () => ({ operationId: 'fixture', status: 'succeeded' as const, exitCode: 0, stdoutTail: '' }));
  const evaluate = vi.fn(async () => 'allow' as const);
  const approve = vi.fn(async () => true);
  const gate = new SafetyGate({ analyzer: { analyze: async () => parsed },
    evaluator: { evaluate }, approvals: { requestApproval: approve }, executor: { execute },
    audit: { proposed: async () => {}, decided: async () => {}, completed: async () => {} },
    lease: { currentGeneration: () => generation, isAgentOwner: () => true }, settings: () => ({ mode, revision: 1 }) });
  return { gate, execute, evaluate, approve, parsed, changeGeneration: () => { generation++; } };
}
const call = (name: string, args: string[]): CommandCall => ({ name, args, dynamic: false, redirects: false, context });

it.each(['ask', 'ai-review', 'permissive'] as const)('never dispatches new deterministic denials in %s', async (mode) => {
  const tar = call('tar', ['-cf', '/dev/sda', 'data']);
  tar.semantics = { coverage: 'complete', unknownReasons: [], tar: { mode: 'create', paths: [
    { kind: 'write', path: '/dev/sda', directory: context.cwd }
  ] } };
  const rm = { ...call('rm', ['-rf', 'etc']), context: { ...context, cwd: { state: 'known' as const, changes: ['/'] } } };
  for (const [raw, calls] of [['tar -cf /dev/sda data', [tar]], ['env -C / rm -rf etc', [call('env', ['-C', '/', 'rm', '-rf', 'etc']), rm]]] as const) {
    const f = fixture(raw, [...calls], mode);
    expect((await f.gate.execute(operation(raw))).decision.verdict).toBe('deny');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.approve).not.toHaveBeenCalled();
  }
});
it('binds exact original Git bytes and rechecks authorization after approval', async () => {
  const raw = 'git -C /srv/app reset --hard';
  const git = call('git', ['-C', '/srv/app', 'reset', '--hard']);
  git.semantics = { coverage: 'complete', unknownReasons: [], git: {
    subcommand: 'reset', args: ['--hard'], directory: { state: 'known', changes: ['/srv/app'] }, paths: []
  } };
  const f = fixture(raw, [git], 'ask');
  f.approve.mockImplementation(async () => { f.changeGeneration(); return true; });
  const op = operation(raw);
  expect((await f.gate.execute(op)).decision.ruleId).toBe('authorization-expired');
  expect(f.approve).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: operationFingerprint(op),
    operation: expect.objectContaining({ command: raw }) }));
  expect(f.execute).not.toHaveBeenCalled();
});
