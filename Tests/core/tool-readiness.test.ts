import { expect, it } from 'vitest';
import { commandEnvironmentFacts } from '../../packages/core/src/tool-readiness.js';
import type { CommandAnalysis, CommandCall, OperationResult } from '../../packages/core/src/model.js';

function call(name: string, args: string[] = [], dynamic = false): CommandCall {
  return { name, args, dynamic, redirects: false };
}
function analysis(raw: string, calls: CommandCall[], overrides: Partial<CommandAnalysis> = {}): CommandAnalysis {
  return { calls, steps: calls.map((one) => ({ call: one, condition: 'always' as const })), redirectTargets: [],
    hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false, raw, ...overrides };
}
function result(overrides: Partial<OperationResult> = {}): OperationResult {
  return { operationId: 'op', status: 'succeeded', exitCode: 0, stdoutTail: '', ...overrides };
}
const readOnly = { readOnly: true };

it('backfills positive readiness for a direct tracked invocation that exited zero', () => {
  const facts = commandEnvironmentFacts(analysis('docker ps', [call('docker', ['ps'])]), result(), readOnly, 'fixture', 1000);
  expect(facts).toEqual({ readiness: [{ tool: 'docker', state: 'responsive', observedAs: 'fixture', observedAt: 1000, evidence: 'exit-0' }],
    staleReadiness: [], presenceStale: false });
  expect(commandEnvironmentFacts(analysis('systemctl is-active nginx', [call('systemctl', ['is-active', 'nginx'])]),
    result(), readOnly, 'fixture', 1001).readiness)
    .toEqual([{ tool: 'systemctl', state: 'responsive', observedAs: 'fixture', observedAt: 1001, evidence: 'exit-0' }]);
});

it('unwraps one sudo layer and records the identity the daemon actually answered', () => {
  expect(commandEnvironmentFacts(analysis('sudo -- docker ps', [call('sudo', ['--', 'docker', 'ps'])]),
    result(), readOnly, 'fixture', 1002).readiness)
    .toEqual([{ tool: 'docker', state: 'responsive', observedAs: 'root', observedAt: 1002, evidence: 'exit-0' }]);
  expect(commandEnvironmentFacts(analysis('sudo -u ops systemctl is-active nginx', [call('sudo', ['-u', 'ops', 'systemctl', 'is-active', 'nginx'])]),
    result(), readOnly, 'fixture', 1003).readiness)
    .toEqual([{ tool: 'systemctl', state: 'responsive', observedAs: 'ops', observedAt: 1003, evidence: 'exit-0' }]);
});

it('keeps readiness unknown for everything weaker than one clean foreground invocation', () => {
  const weak = [
    analysis('docker ps | grep web', [call('docker', ['ps'])], { hasPipeline: true }),
    analysis('docker $CMD', [call('docker', ['$CMD'])], { hasExpansion: true }),
    analysis('docker ps &', [call('docker', ['ps'])], { hasError: true }),
    analysis('docker ps', [call('docker', ['ps'], true)]),
    analysis('docker ps; systemctl status', [call('docker', ['ps']), call('systemctl', ['status'])]),
    analysis('/usr/bin/docker ps', [call('/usr/bin/docker', ['ps'])]),
    analysis('git status', [call('git', ['status'])]),
    analysis('sudo -- true', [call('sudo', ['--', 'true'])]),
    analysis('sudo -x docker ps', [call('sudo', ['-x', 'docker', 'ps'])])
  ];
  for (const item of weak)
    expect(commandEnvironmentFacts(item, result(), readOnly, 'fixture', 1004).readiness).toEqual([]);
  expect(commandEnvironmentFacts(analysis('docker ps', [call('docker', ['ps'])]),
    result({ status: 'failed', exitCode: 1 }), readOnly, 'fixture', 1004).readiness).toEqual([]);
  expect(commandEnvironmentFacts(analysis('docker ps', [call('docker', ['ps'])]),
    result({ exitCode: undefined }), readOnly, 'fixture', 1004).readiness).toEqual([]);
  expect(commandEnvironmentFacts(analysis('docker ps', [call('docker', ['ps'])]),
    result({ status: 'unknown', exitCode: undefined, effects: 'possible' }), readOnly, 'fixture', 1004).readiness).toEqual([]);
});

it('a dispatched mutation drops mentioned tool readiness first, then backfills its own exit-0', () => {
  const facts = commandEnvironmentFacts(analysis('systemctl stop docker', [call('systemctl', ['stop', 'docker'])]),
    result(), undefined, 'fixture', 1005);
  expect(facts.staleReadiness.sort()).toEqual(['docker', 'systemctl']);
  expect(facts.presenceStale).toBe(true);
  expect(facts.readiness).toEqual([{ tool: 'systemctl', state: 'responsive', observedAs: 'fixture', observedAt: 1005, evidence: 'exit-0' }]);
});

it('mention matching covers renamed binaries, package names and socket paths', () => {
  const cases: Array<[string, CommandCall, string[]]> = [
    ['/usr/bin/docker rm web', call('/usr/bin/docker', ['rm', 'web']), ['docker']],
    ['apt-get remove docker.io', call('apt-get', ['remove', 'docker.io']), ['docker']],
    ['rm -f /var/run/docker.sock', call('rm', ['-f', '/var/run/docker.sock']), ['docker']],
    ['echo docker', call('echo', ['docker']), ['docker']],
    ['systemctl status nginx', call('systemctl', ['status', 'nginx']), ['systemctl']],
    ['tailf /var/log/messages', call('tailf', ['/var/log/messages']), []],
    ['apt-get upgrade', call('apt-get', ['upgrade']), []]
  ];
  for (const [raw, one, expected] of cases) {
    const facts = commandEnvironmentFacts(analysis(raw, [one]), result(), undefined, 'fixture', 1006);
    expect(facts.staleReadiness.sort()).toEqual(expected.sort());
    expect(facts.presenceStale).toBe(true);
  }
});

it('failures that provably never reached the host invalidate nothing', () => {
  for (const failureKind of ['not-dispatched', 'unresolved-prior-operation'] as const) {
    const facts = commandEnvironmentFacts(analysis('systemctl stop docker', [call('systemctl', ['stop', 'docker'])]),
      result({ status: 'failed', exitCode: undefined, effects: 'none', failureKind }), undefined, 'fixture', 1007);
    expect(facts).toEqual({ readiness: [], staleReadiness: [], presenceStale: false });
  }
  // Unproven or partial effects stay invalidating; only proven absence is skipped.
  expect(commandEnvironmentFacts(analysis('systemctl stop docker', [call('systemctl', ['stop', 'docker'])]),
    result({ status: 'failed', exitCode: undefined, effects: 'possible', failureKind: 'not-dispatched' }), undefined, 'fixture', 1007).presenceStale)
    .toBe(true);
  expect(commandEnvironmentFacts(analysis('systemctl stop docker', [call('systemctl', ['stop', 'docker'])]),
    result({ status: 'failed', exitCode: undefined, effects: 'none', failureKind: 'permission-denied' }), undefined, 'fixture', 1007).presenceStale)
    .toBe(true);
});

it('read-only commands never invalidate presence or readiness, and failures record no negative fact', () => {
  const facts = commandEnvironmentFacts(analysis('systemctl stop docker', [call('systemctl', ['stop', 'docker'])]),
    result({ status: 'failed', exitCode: 1, stdoutTail: 'not loaded' }), readOnly, 'fixture', 1008);
  expect(facts).toEqual({ readiness: [], staleReadiness: [], presenceStale: false });
});

it('unknown or handed-over mutations still invalidate; every layer keeps its own trigger', () => {
  for (const status of ['unknown', 'handed-over'] as const) {
    const facts = commandEnvironmentFacts(analysis('mkdir /srv/app', [call('mkdir', ['/srv/app'])]),
      result({ status, exitCode: undefined, effects: 'possible' }), undefined, 'fixture', 1009);
    expect(facts).toEqual({ readiness: [], staleReadiness: [], presenceStale: true });
  }
});
